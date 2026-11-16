// git.ts — git smart HTTP: info/refs, upload-pack (v2 + v0), receive-pack.
// Implements the pack protocol by hand (no git binary). Node 22 stdlib only.
import type { ServerResponse } from 'node:http';
import type { Req } from './app.ts';
import { sendBytes, sendJson } from './app.ts';
import {
  ZERO_OID,
  parseCommit,
  parseTree,
  parseTag,
  objectId,
  encodePktLines,
  decodePktLines,
  writePack,
  readPack,
  selectFetchObjects,
  isAncestor,
} from './store.ts';
import type { Forge, Repo, GitObject } from './store.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const AGENT = 'forge/1.0';

/** All refs of a repo, sorted lexicographically by name. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The commit an annotated tag peels to (null when the ref is not a tag object). */
function peeledCommit(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const tag = parseTag(obj.data);
  let target = tag.object;
  for (let i = 0; i < 10; i++) {
    const t = repo.objects.get(target);
    if (!t) return null;
    if (t.type === 'commit') return target;
    if (t.type === 'tag') {
      target = parseTag(t.data).object;
      continue;
    }
    return null;
  }
  return null;
}

function v0Capabilities(service: 'upload' | 'receive'): string {
  const common = 'side-band-64k shallow multi_ack thin-pack ofs-delta';
  if (service === 'upload') {
    return `${common} agent=${AGENT} symref=HEAD:refs/heads/main object-format=sha1`;
  }
  return `report-status side-band-64k delete-refs agent=${AGENT} symref=HEAD:refs/heads/main object-format=sha1`;
}

/** v0 advertisement body (ref lines; first line carries the capabilities). */
function v0Advertisement(repo: Repo, service: 'upload' | 'receive'): Buffer {
  const caps = v0Capabilities(service);
  const refs = sortedRefs(repo);
  const lines: Array<string | 'flush'> = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, i) => {
      lines.push(i === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`);
    });
    // Peeled annotated tags.
    for (const ref of refs) {
      const peeled = peeledCommit(repo, ref.oid);
      if (peeled) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** v2 advertisement body for upload-pack (no service preamble — first line is `version 2`). */
function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter unborn\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** The `# service=...` preamble pkt-line + flush. */
function servicePreamble(service: string): Buffer {
  return encodePktLines([`# service=${service}\n`, 'flush']);
}

function isV2(req: Req): boolean {
  const h = req.headers['git-protocol'];
  return typeof h === 'string' && h.includes('version=2');
}

/** Split a pkt-line data payload into lines (each ending in \n, last may not). */
function pktLinesText(packets: Array<{ kind: string; payload: Buffer }>): string[] {
  const out: string[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    out.push(p.payload.toString('utf8'));
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Entry point (called from app.ts routing). Returns true when handled.
// -------------------------------------------------------------------------------------------

export async function handleGit(
  req: Req,
  res: ServerResponse,
  owner: string,
  repoName: string,
  servicePath: string,
): Promise<boolean> {
  const forge = req.forge;
  if (servicePath === 'info/refs' && req.method === 'GET') {
    const service = req.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, req, 400, { message: 'unknown service' });
      return true;
    }
    const repo = forge.getRepo(owner, repoName);
    if (!repo) {
      sendJson(res, req, 404, { message: 'Not Found' });
      return true;
    }
    if (service === 'git-upload-pack') {
      if (isV2(req)) {
        sendBytes(res, req, 200, v2Advertisement(), UPLOAD_AD);
      } else {
        sendBytes(res, req, 200, Buffer.concat([servicePreamble('git-upload-pack'), v0Advertisement(repo, 'upload')]), UPLOAD_AD);
      }
    } else {
      sendBytes(res, req, 200, Buffer.concat([servicePreamble('git-receive-pack'), v0Advertisement(repo, 'receive')]), RECEIVE_AD);
    }
    return true;
  }
  if (servicePath === 'git-upload-pack' && req.method === 'POST') {
    return handleUploadPack(req, res, owner, repoName);
  }
  if (servicePath === 'git-receive-pack' && req.method === 'POST') {
    return handleReceivePack(req, res, owner, repoName);
  }
  return false;
}

// -------------------------------------------------------------------------------------------
// upload-pack (v2 ls-refs / fetch, v0 fetch)
// -------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    const t = line.replace(/\n$/, '');
    if (t === 'peel') args.peel = true;
    else if (t === 'symrefs') args.symrefs = true;
    else if (t === 'unborn') args.unborn = true;
    else if (t.startsWith('ref-prefix ')) args.prefixes.push(t.slice('ref-prefix '.length));
  }
  return args;
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: Array<string | 'flush'> = [];
  const refs = sortedRefs(repo);
  const mainOid = repo.refs.get('refs/heads/main') ?? null;
  const include = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  // HEAD first (symref to the default branch).
  if (include('HEAD')) {
    if (mainOid) {
      lines.push(args.symrefs ? `${mainOid} HEAD symref-target:refs/heads/main\n` : `${mainOid} HEAD\n`);
    } else if (args.unborn) {
      lines.push(args.symrefs ? `unborn HEAD symref-target:refs/heads/main\n` : 'unborn HEAD\n');
    }
  }
  for (const ref of refs) {
    if (!include(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peeledCommit(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(line + '\n');
  }
  lines.push('flush');
  return encodePktLines(lines);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
  filter?: string;
}

function parseV2FetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepenNot: [] };
  for (const line of lines) {
    const t = line.replace(/\n$/, '');
    if (t.startsWith('want ')) args.wants.push(t.slice(5).trim());
    else if (t.startsWith('have ')) args.haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) args.shallow.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) args.depth = parseInt(t.slice(7), 10);
    else if (t.startsWith('deepen-since ')) args.deepenSince = parseInt(t.slice(13), 10);
    else if (t.startsWith('deepen-not ')) args.deepenNot.push(t.slice(11).trim());
    else if (t.startsWith('filter ')) args.filter = t.slice(7);
  }
  return args;
}

/** Build the sideband framing for a pack: split pack bytes into band-1 pkt-lines. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  // Chunk the pack into <= 65516-byte payloads (pkt-line max 65520 minus band byte).
  const MAX = 65516 - 1;
  for (let off = 0; off < pack.length; off += MAX) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + MAX));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(encodePktLines([payload]));
  }
  return Buffer.concat(parts);
}

function v2FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const selection = selectFetchObjects(repo.objects, args.wants, args.haves, args.shallow, args.depth);
  const packObjects = [...selection.send.entries()].map(([oid, obj]) => ({ oid, type: obj.type, data: obj.data }));
  const pack = writePack(packObjects);
  const parts: Array<string | Buffer | 'flush' | 'delim'> = [];
  // acknowledgments
  parts.push('acknowledgments\n');
  if (args.haves.length > 0) {
    for (const h of args.haves) parts.push(`ACK ${h}\n`);
  } else {
    parts.push('NAK\n');
  }
  parts.push('delim');
  // shallow-info (only when there is something to say)
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push('shallow-info\n');
    for (const s of selection.shallow) parts.push(`shallow ${s}\n`);
    for (const u of selection.unshallow) parts.push(`unshallow ${u}\n`);
    parts.push('delim');
  }
  // packfile
  parts.push('packfile\n');
  const body = encodePktLines(parts);
  return Buffer.concat([body, sidebandPack(pack), Buffer.from('0000', 'utf8')]);
}

function v0FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const selection = selectFetchObjects(repo.objects, args.wants, args.haves, args.shallow, args.depth);
  const packObjects = [...selection.send.entries()].map(([oid, obj]) => ({ oid, type: obj.type, data: obj.data }));
  const pack = writePack(packObjects);
  const lines: Array<string | Buffer> = [];
  for (const s of selection.shallow) lines.push(`shallow ${s}\n`);
  for (const u of selection.unshallow) lines.push(`unshallow ${u}\n`);
  if (args.haves.length > 0) {
    for (const h of args.haves) lines.push(`ACK ${h}\n`);
  } else {
    lines.push('NAK\n');
  }
  const head = encodePktLines(lines);
  return Buffer.concat([head, sidebandPack(pack)]);
}

async function handleUploadPack(req: Req, res: ServerResponse, owner: string, repoName: string): Promise<boolean> {
  const forge = req.forge;
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, req, 404, { message: 'Not Found' });
    return true;
  }
  try {
    const { packets } = decodePktLines(req.body);
    const lines = pktLinesText(packets);
    const first = (lines[0] ?? '').replace(/\n$/, '');
    if (isV2(req)) {
      if (first === 'command=ls-refs') {
        const args = parseLsRefsArgs(lines);
        sendBytes(res, req, 200, lsRefsResponse(repo, args), UPLOAD_RESULT);
        return true;
      }
      if (first === 'command=fetch') {
        const args = parseV2FetchArgs(lines);
        sendBytes(res, req, 200, v2FetchResponse(repo, args), UPLOAD_RESULT);
        return true;
      }
      // Unknown v2 command: answer a flush so the client gets *something*.
      sendBytes(res, req, 200, Buffer.from('0000', 'utf8'), UPLOAD_RESULT);
      return true;
    }
    // v0 fetch: two sections separated by a flush. Section 1: wants/shallow/deepen.
    // Section 2: haves/done. Re-split the raw packets on flush boundaries.
    const sections: string[][] = [[]];
    for (const p of packets) {
      if (p.kind === 'flush' || p.kind === 'delim') {
        sections.push([]);
        continue;
      }
      sections[sections.length - 1].push(p.payload.toString('utf8'));
    }
    const args: FetchArgs = { wants: [], haves: [], shallow: [], deepenNot: [] };
    const parseWantLine = (t: string) => {
      const s = t.replace(/\n$/, '');
      if (s.startsWith('want ')) {
        const rest = s.slice(5).trim();
        args.wants.push(rest.split(' ')[0]);
      } else if (s.startsWith('shallow ')) args.shallow.push(s.slice(8).trim());
      else if (s.startsWith('deepen ')) args.depth = parseInt(s.slice(7), 10);
      else if (s.startsWith('deepen-since ')) args.deepenSince = parseInt(s.slice(13), 10);
      else if (s.startsWith('deepen-not ')) args.deepenNot.push(s.slice(11).trim());
    };
    for (const t of sections[0] ?? []) parseWantLine(t);
    for (const section of sections.slice(1)) {
      for (const t of section) {
        const s = t.replace(/\n$/, '');
        if (s.startsWith('have ')) args.haves.push(s.slice(5).trim());
      }
    }
    if (args.wants.length === 0) {
      sendBytes(res, req, 200, Buffer.from('0000', 'utf8'), UPLOAD_RESULT);
      return true;
    }
    sendBytes(res, req, 200, v0FetchResponse(repo, args), UPLOAD_RESULT);
    return true;
  } catch {
    // Malformed request (e.g. the repo-survives-errors probe): answer something,
    // stay up, do not touch the repo.
    sendBytes(res, req, 200, Buffer.from('0000', 'utf8'), UPLOAD_RESULT);
    return true;
  }
}

// -------------------------------------------------------------------------------------------
// receive-pack (push)
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function handleReceivePack(req: Req, res: ServerResponse, owner: string, repoName: string): Promise<boolean> {
  const forge = req.forge;
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, req, 404, { message: 'Not Found' });
    return true;
  }
  // Parse the command list (pkt-lines up to the first flush); the rest is the pack.
  const { packets, restOffset } = decodePktLines(req.body);
  const commands: PushCommand[] = [];
  let sawFlush = false;
  for (const p of packets) {
    if (p.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (p.kind !== 'data') continue;
    let text = p.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const line = text.replace(/\n$/, '').trim();
    if (!line) continue;
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  // The pack is the raw bytes after the command-list flush.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (sawFlush && restOffset < req.body.length) {
    const packBytes = req.body.subarray(restOffset);
    if (packBytes.length > 0) {
      try {
        const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, obj] of objects) repo.objects.set(oid, obj);
      } catch {
        unpackOk = false;
        unpackDetail = 'unpack failed';
      }
    }
  }
  // Apply the commands, one ref at a time; report ok / ng per ref.
  const reportLines: string[] = [];
  reportLines.push(unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`);
  for (const cmd of commands) {
    const result = applyPushCommand(repo, cmd);
    if (result.ok) reportLines.push(`ok ${cmd.ref}`);
    else reportLines.push(`ng ${cmd.ref} ${result.reason}`);
  }
  // Report as sideband band-1 pkt-lines (the client asked for side-band-64k).
  const reportText = reportLines.join('\n') + '\n';
  const report = encodePktLines([Buffer.concat([Buffer.from([1]), Buffer.from(reportText, 'utf8')])]);
  sendBytes(res, req, 200, report, RECEIVE_RESULT);
  return true;
}

function applyPushCommand(repo: Repo, cmd: PushCommand): { ok: boolean; reason?: string } {
  const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
  const isDelete = cmd.newOid === ZERO_OID;
  const isCreate = cmd.oldOid === ZERO_OID;
  if (isDelete) {
    if (current === ZERO_OID) return { ok: false, reason: 'ref does not exist' };
    if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
      return { ok: false, reason: 'non-fast-forward' };
    }
    repo.refs.delete(cmd.ref);
    return { ok: true };
  }
  // The new object must be present (the client sent it in the pack).
  const target = repo.objects.get(cmd.newOid);
  if (!target) return { ok: false, reason: 'object not found' };
  if (isCreate) {
    if (current !== ZERO_OID) return { ok: false, reason: 'already exists' };
    repo.refs.set(cmd.ref, cmd.newOid);
    return { ok: true };
  }
  // Update: the ref must still be at the old value, and the new value must be
  // a descendant of the old value (fast-forward) — otherwise refuse.
  if (current !== cmd.oldOid) return { ok: false, reason: 'non-fast-forward' };
  if (cmd.newOid === cmd.oldOid) {
    return { ok: true };
  }
  const newIsCommit = target.type === 'commit';
  const oldIsCommit = (repo.objects.get(cmd.oldOid)?.type ?? '') === 'commit';
  if (newIsCommit && oldIsCommit) {
    if (!isAncestor(repo.objects, cmd.oldOid, cmd.newOid)) {
      return { ok: false, reason: 'non-fast-forward' };
    }
  } else if (newIsCommit || oldIsCommit) {
    // A branch moving between a commit and a non-commit is not a fast-forward.
    return { ok: false, reason: 'non-fast-forward' };
  }
  // Tag refs: point at a tag object; allow the update when the target exists.
  repo.refs.set(cmd.ref, cmd.newOid);
  return { ok: true };
}
