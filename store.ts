// store.ts — in-memory forge store, git object model, pack codec, reachability,
// three-way merge. Node 22 stdlib only (node:crypto, node:zlib). No dependencies.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of a (type, content) pair: sha1("<type> <len>\0" + content). */
export function objectId(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function makeBlob(content: Buffer): { oid: string; object: GitObject } {
  return { oid: objectId('blob', content), object: { type: 'blob', data: content } };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object body into entries. Tree bodies are binary: "<mode> <name>\0<20-byte oid>". */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(pos, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Build a tree object body from entries. Git sorts by name, with directories
 *  compared as if their name had a trailing "/". */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? a.name + '/' : a.name;
    const bn = b.mode === '40000' ? b.name + '/' : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const p of info.parents) lines.push(`parent ${p}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(lines.join('\n') + '\n\n' + info.message, 'utf8');
}

export interface TagInfo {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const info: TagInfo = { object: '', type: 'commit', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) info.tag = line.slice(4);
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

export function buildTag(info: TagInfo): Buffer {
  const lines = [
    `object ${info.object}`,
    `type ${info.type}`,
    `tag ${info.tag}`,
    `tagger ${info.tagger}`,
  ];
  return Buffer.from(lines.join('\n') + '\n\n' + info.message, 'utf8');
}

// -------------------------------------------------------------------------------------------
// pkt-line codec (git smart HTTP framing)
// -------------------------------------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'utf8');
export const PKT_DELIM = Buffer.from('0001', 'utf8');

export type PktItem = string | Buffer | 'flush' | 'delim';

export function encodePktLines(items: PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export interface DecodedPkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines. Returns packets and the offset where the
 *  pkt-line stream ended (the rest of the buffer is raw data, e.g. a packfile). */
export function decodePktLines(buf: Buffer): { packets: DecodedPkt[]; restOffset: number } {
  const packets: DecodedPkt[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const lenHex = buf.subarray(pos, pos + 4).toString('utf8');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { packets, restOffset: pos };
}

// -------------------------------------------------------------------------------------------
// packfile codec (plain objects; read also resolves ofs/ref deltas defensively)
// -------------------------------------------------------------------------------------------

const OBJ_TYPE_CODES: Record<string, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
  'ofs-delta': 6,
  'ref-delta': 7,
};
const OBJ_CODE_TYPES: Record<number, ObjType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

function encodeObjectHeader(typeCode: number, size: number): Buffer {
  // varint: low 4 bits of size in first byte with type in bits 4-6, continuation bit 7.
  const bytes: number[] = [];
  let s = size;
  let first = (typeCode << 4) | (s & 0x0f);
  s >>>= 4;
  if (s > 0) first |= 0x80;
  bytes.push(first);
  while (s > 0) {
    let b = s & 0x7f;
    s >>>= 7;
    if (s > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Write a packfile (version 2) holding plain objects only — no deltas. */
export function writePack(objects: Array<{ oid: string; type: ObjType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const code = OBJ_TYPE_CODES[obj.type];
    const compressed = deflateSync(obj.data);
    parts.push(encodeObjectHeader(code, obj.data.length));
    parts.push(compressed);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git binary delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) offset |= delta[pos++] << (8 * i);
      }
      for (let i = 0; i < 3; i++) {
        if (op & (0x10 << i)) size |= delta[pos++] << (8 * i);
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || outLen !== resultSize) {
    throw new Error('delta result size mismatch');
  }
  return result;
}

export interface PackedObject {
  oid: string;
  type: ObjType;
  data: Buffer;
}


/** Inflate a deflate stream at the start of `input`, knowing the expected
 *  decompressed size. inflateSync ignores trailing bytes, so the stream length
 *  is found by binary search for the smallest prefix that inflates fully. */
function inflateBounded(input: Buffer, expectedSize: number): { data: Buffer; consumed: number } {
  let full: Buffer;
  try {
    full = inflateSync(input);
  } catch {
    throw new Error('pack entry inflate failed');
  }
  if (full.length !== expectedSize) throw new Error('pack entry size mismatch');
  let lo = 1;
  let hi = input.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(input.subarray(0, mid));
      if (out.length === expectedSize) hi = mid;
      else lo = mid + 1;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(input.subarray(0, lo)), consumed: lo };
}

/** Read a packfile. Resolves ofs/ref deltas against objects in the same pack
 *  and, for ref-deltas, against `resolveBase` (the repo's existing objects). */
export function readPack(
  buf: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expect = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(expect)) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  // First pass: read all entries, deferring deltas.
  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const entries: RawEntry[] = [];
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const startOffset = pos;
    const first = buf[pos++];
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let byte = first;
    while (byte & 0x80) {
      byte = buf[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // ofs-delta: negative offset varint.
      let b = buf[pos++];
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = buf[pos++];
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      const { data, consumed } = inflateBounded(buf.subarray(pos, buf.length - 20), size);
      pos += consumed;
      entries.push({ offset: startOffset, typeCode, size, data, baseOffset: startOffset - offset });
    } else if (typeCode === 7) {
      // ref-delta: 20-byte base oid.
      const baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const { data, consumed } = inflateBounded(buf.subarray(pos, buf.length - 20), size);
      pos += consumed;
      entries.push({ offset: startOffset, typeCode, size, data, baseOid });
    } else {
      const type = OBJ_CODE_TYPES[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, consumed } = inflateBounded(buf.subarray(pos, buf.length - 20), size);
      pos += consumed;
      const oid = objectId(type, data);
      const obj: GitObject = { type, data };
      objects.set(oid, obj);
      byOffset.set(startOffset, obj);
      entries.push({ offset: startOffset, typeCode, size, data });
    }
  }
  // Second pass: resolve deltas (bases are always earlier in the pack, or in the repo).
  for (const e of entries) {
    if (e.typeCode !== 6 && e.typeCode !== 7) continue;
    let base: GitObject | undefined;
    if (e.typeCode === 6 && e.baseOffset !== undefined) base = byOffset.get(e.baseOffset);
    if (e.typeCode === 7 && e.baseOid) {
      base = objects.get(e.baseOid) ?? resolveBase?.(e.baseOid);
    }
    if (!base) throw new Error('delta base not found');
    const data = applyDelta(base.data, e.data);
    const oid = objectId(base.type, data);
    const obj: GitObject = { type: base.type, data };
    objects.set(oid, obj);
    byOffset.set(e.offset, obj);
  }
  return objects;
}

// -------------------------------------------------------------------------------------------
// reachability + fetch object selection
// -------------------------------------------------------------------------------------------

/** Commit generations from tips: generation 0 = the tips, 1 = their parents, ...
 *  Stops expanding a commit once its generation reaches `maxGen` (its parents are
 *  not visited), so a depth-limited walk stays cheap. */
export function commitGenerations(
  objects: Map<string, GitObject>,
  tips: string[],
  maxGen = Infinity,
): Map<string, number> {
  const gen = new Map<string, number>();
  const queue: Array<{ oid: string; g: number }> = [];
  for (const tip of tips) {
    if (objects.get(tip)?.type === 'commit' && !gen.has(tip)) {
      gen.set(tip, 0);
      queue.push({ oid: tip, g: 0 });
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const { oid, g } = queue[i];
    if (g >= maxGen) continue;
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!gen.has(parent) && objects.get(parent)?.type === 'commit') {
        gen.set(parent, g + 1);
        queue.push({ oid: parent, g: g + 1 });
      }
    }
  }
  return gen;
}

/** All objects reachable from `tips`, not descending past `stopAt` commits'
 *  parents (a shallow boundary: the client holds the boundary commit itself
 *  but none of its ancestors). Includes the tips' trees and blobs. */
export function reachableFrom(
  objects: Map<string, GitObject>,
  tips: string[],
  stopAt?: Set<string>,
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (c.tree) stack.push(c.tree);
      // Do not descend past a shallow boundary commit's parents.
      if (!stopAt?.has(oid)) {
        for (const p of c.parents) stack.push(p);
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

export interface FetchSelection {
  /** Objects to send, as a map oid -> object. */
  send: Map<string, GitObject>;
  /** New shallow boundary commits (deepest generation included). */
  shallow: string[];
  /** Old shallow boundary commits that are now interior (no longer boundary). */
  unshallow: string[];
}

/** Select the objects for a fetch: wants + depth + haves + shallow boundary. */
export function selectFetchObjects(
  objects: Map<string, GitObject>,
  wants: string[],
  haves: string[],
  shallowBoundary: string[],
  depth?: number,
): FetchSelection {
  const shallowSet = new Set(shallowBoundary);
  // Wanted: commits within depth of the wants, plus their trees/blobs.
  const wanted = new Set<string>();
  if (depth !== undefined) {
    const gen = commitGenerations(objects, wants, depth - 1);
    const includedCommits: string[] = [];
    for (const [oid, g] of gen) {
      if (g < depth) includedCommits.push(oid);
    }
    // Include the wanted non-commit objects themselves (tags, etc.).
    for (const w of wants) {
      const obj = objects.get(w);
      if (obj && obj.type !== 'commit') wanted.add(w);
      if (obj && obj.type === 'tag') {
        // A wanted tag pulls its target chain.
        const target = parseTag(obj.data).object;
        const tg = commitGenerations(objects, [target]);
        for (const [oid, g] of tg) if (g < depth) includedCommits.push(oid);
        wanted.add(target);
      }
    }
    for (const c of includedCommits) {
      const s = reachableFrom(objects, [c], new Set([c]));
      for (const o of s) wanted.add(o);
    }
    // The included commits' trees/blobs: reachableFrom with stopAt={c} gives
    // the commit + its tree + blobs, but not its parents. That is exactly the
    // depth-limited closure when applied per included commit.
    const boundary = includedCommits.filter((oid) => (gen.get(oid) ?? 0) === depth - 1);
    const unshallow = shallowBoundary.filter((oid) => {
      const g = gen.get(oid);
      return g !== undefined && g < depth - 1;
    });
    const held = reachableFrom(objects, haves, shallowSet);
    const send = new Map<string, GitObject>();
    for (const oid of wanted) {
      if (!held.has(oid)) {
        const obj = objects.get(oid);
        if (obj) send.set(oid, obj);
      }
    }
    return { send, shallow: boundary, unshallow };
  }
  // No depth limit: everything reachable from wants, minus what the client holds.
  const wantedAll = reachableFrom(objects, wants);
  const held = reachableFrom(objects, haves, shallowSet);
  const send = new Map<string, GitObject>();
  for (const oid of wantedAll) {
    if (!held.has(oid)) {
      const obj = objects.get(oid);
      if (obj) send.set(oid, obj);
    }
  }
  return { send, shallow: [], unshallow: [] };
}

// -------------------------------------------------------------------------------------------
// tree helpers
// -------------------------------------------------------------------------------------------

/** Build a tree (and subtrees) from a flat file list. Stores all objects.
 *  Returns the root tree oid. */
export function treeFromFiles(
  objects: Map<string, GitObject>,
  files: Array<{ path: string; content: Buffer }>,
): string {
  // Group files by directory, recursively.
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Map<string, Array<{ path: string; content: Buffer }>>();
    for (const f of files) {
      if (!f.path.startsWith(prefix)) continue;
      const rest = f.path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        const { oid, object } = makeBlob(f.content);
        objects.set(oid, object);
        entries.push({ mode: '100644', name: rest, oid });
      } else {
        const dir = rest.slice(0, slash);
        const list = subdirs.get(dir) ?? [];
        list.push(f);
        subdirs.set(dir, list);
      }
    }
    for (const [dir, list] of subdirs) {
      const sub = build(prefix + dir + '/');
      void list;
      entries.push({ mode: '40000', name: dir, oid: sub });
    }
    const data = buildTree(entries);
    const oid = objectId('tree', data);
    objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build('');
}

/** Read a file's blob at a tree. Returns null when the path is absent. */
export function getBlobAt(
  objects: Map<string, GitObject>,
  treeOid: string,
  path: string,
): { oid: string; data: Buffer } | null {
  const parts = path.split('/').filter((p) => p.length > 0);
  let current = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const obj = objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) {
      if (entry.mode === '40000') return null;
      const blob = objects.get(entry.oid);
      if (!blob || blob.type !== 'blob') return null;
      return { oid: entry.oid, data: blob.data };
    }
    current = entry.oid;
  }
  return null;
}

/** Return a new tree oid with `path` set to `blobOid` (or removed when null),
 *  starting from `baseTreeOid` (ZERO_OID = empty tree). Stores new trees. */
export function updateTree(
  objects: Map<string, GitObject>,
  baseTreeOid: string,
  path: string,
  blobOid: string | null,
): string {
  const parts = path.split('/').filter((p) => p.length > 0);
  const rec = (treeOid: string, depth: number): string => {
    const obj = treeOid === ZERO_OID ? null : objects.get(treeOid);
    const entries = obj && obj.type === 'tree' ? parseTree(obj.data) : [];
    const name = parts[depth];
    const isLast = depth === parts.length - 1;
    const idx = entries.findIndex((e) => e.name === name);
    if (isLast) {
      if (blobOid === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else {
        const entry: TreeEntry = { mode: '100644', name, oid: blobOid };
        if (idx >= 0) entries[idx] = entry;
        else entries.push(entry);
      }
    } else {
      const childOid = idx >= 0 ? entries[idx].oid : ZERO_OID;
      const newChild = rec(childOid, depth + 1);
      if (newChild === ZERO_OID) {
        if (idx >= 0) entries.splice(idx, 1);
      } else {
        const entry: TreeEntry = { mode: '40000', name, oid: newChild };
        if (idx >= 0) entries[idx] = entry;
        else entries.push(entry);
      }
    }
    if (entries.length === 0) return ZERO_OID;
    const data = buildTree(entries);
    const oid = objectId('tree', data);
    objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return rec(baseTreeOid, 0);
}

/** Flatten a tree into path -> {oid, mode} (files only). */
export function flattenTree(
  objects: Map<string, GitObject>,
  treeOid: string,
  prefix = '',
): Array<{ path: string; oid: string; mode: string }> {
  const out: Array<{ path: string; oid: string; mode: string }> = [];
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    if (e.mode === '40000') {
      out.push(...flattenTree(objects, e.oid, prefix + e.name + '/'));
    } else {
      out.push({ path: prefix + e.name, oid: e.oid, mode: e.mode });
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// merge (three-way, line based) + diff
// -------------------------------------------------------------------------------------------

/** Find a merge base of two commits (nearest common ancestor by generation). */
export function findMergeBase(
  objects: Map<string, GitObject>,
  a: string,
  b: string,
): string | null {
  if (a === b) return a;
  const genA = commitGenerations(objects, [a]);
  const genB = commitGenerations(objects, [b]);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, ga] of genA) {
    const gb = genB.get(oid);
    if (gb === undefined) continue;
    const score = ga + gb;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

/** Is `ancestor` an ancestor of (or equal to) `descendant`? Stops as soon as the
 *  ancestor is found, so a fast-forward check is O(1) instead of O(history). */
export function isAncestor(
  objects: Map<string, GitObject>,
  ancestor: string,
  descendant: string,
): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

export interface MergeResult {
  /** The merged tree oid (stored). Null when the merge conflicts. */
  treeOid: string | null;
  /** Paths that conflicted. */
  conflicts: string[];
  /** Paths changed by the merge (for files list). */
  changedPaths: string[];
}

/** Three-way merge of trees: base -> ours (base tip) and base -> theirs (head tip).
 *  Stores the merged tree. Line-based per file; a file conflicts when both sides
 *  changed it differently from base. */
export function threeWayMerge(
  objects: Map<string, GitObject>,
  baseTreeOid: string,
  oursTreeOid: string,
  theirsTreeOid: string,
): MergeResult {
  const baseFiles = new Map(flattenTree(objects, baseTreeOid).map((f) => [f.path, f.oid]));
  const oursFiles = new Map(flattenTree(objects, oursTreeOid).map((f) => [f.path, f.oid]));
  const theirsFiles = new Map(flattenTree(objects, theirsTreeOid).map((f) => [f.path, f.oid]));
  const conflicts: string[] = [];
  const changedPaths: string[] = [];
  const merged = new Map<string, string>(); // path -> blob oid
  const allPaths = new Set([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
  for (const path of allPaths) {
    const b = baseFiles.get(path);
    const o = oursFiles.get(path);
    const t = theirsFiles.get(path);
    if (o === t) {
      // Same on both sides (including both deleted).
      if (o !== undefined) merged.set(path, o);
      continue;
    }
    if (b === o) {
      // Only theirs changed.
      if (t !== undefined) {
        merged.set(path, t);
        changedPaths.push(path);
      }
      continue;
    }
    if (b === t) {
      // Only ours changed.
      if (o !== undefined) {
        merged.set(path, o);
        changedPaths.push(path);
      }
      continue;
    }
    // Both changed differently — try a line merge.
    const baseContent = b ? (objects.get(b)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const oursContent = o ? (objects.get(o)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const theirsContent = t ? (objects.get(t)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const mergedContent = mergeFileContents(baseContent, oursContent, theirsContent);
    if (mergedContent === null) {
      conflicts.push(path);
      continue;
    }
    const { oid, object } = makeBlob(mergedContent);
    objects.set(oid, object);
    merged.set(path, oid);
    changedPaths.push(path);
  }
  if (conflicts.length > 0) return { treeOid: null, conflicts, changedPaths };
  const files = [...merged.entries()].map(([path, oid]) => {
    const obj = objects.get(oid);
    return { path, content: obj?.data ?? Buffer.alloc(0) };
  });
  const treeOid = treeFromFiles(objects, files);
  return { treeOid, conflicts, changedPaths };
}

/** Line-based three-way merge of one file. Returns null on conflict.
 *  Uses a simple diff3: when both sides changed the same region differently,
 *  it conflicts. Non-overlapping changes merge cleanly. */
export function mergeFileContents(
  base: Buffer,
  ours: Buffer,
  theirs: Buffer,
): Buffer | null {
  if (ours.equals(theirs)) return ours;
  if (base.equals(ours)) return theirs;
  if (base.equals(theirs)) return ours;
  const baseLines = splitLines(base);
  const oursLines = splitLines(ours);
  const theirsLines = splitLines(theirs);
  // Diff base->ours and base->theirs as (start,end,replacement) hunks, then apply
  // non-overlapping hunks. Overlapping hunks that produce the same result are ok.
  const hunksOurs = diffHunks(baseLines, oursLines);
  const hunksTheirs = diffHunks(baseLines, theirsLines);
  const sameHunk = (a: Hunk, b: Hunk): boolean =>
    a.start === b.start && a.end === b.end && a.replacement.join('\n') === b.replacement.join('\n');
  // Two hunks interfere when: their base ranges intersect (and they are not the
  // same hunk); both are pure insertions at the same position with different
  // text; or a pure insertion falls strictly inside the other's changed range.
  const interferes = (a: Hunk, b: Hunk): boolean => {
    if (sameHunk(a, b)) return false;
    const aPure = a.start === a.end;
    const bPure = b.start === b.end;
    if (aPure && bPure) return a.start === b.start;
    if (aPure) return b.start < a.start && a.start < b.end;
    if (bPure) return a.start < b.start && b.start < a.end;
    return a.start < b.end && b.start < a.end;
  };
  for (const h1 of hunksOurs) {
    for (const h2 of hunksTheirs) {
      if (interferes(h1, h2)) return null;
    }
  }
  // Apply all hunks (ours first, then theirs) to the base lines, deduplicating
  // identical hunks so the same insertion is not applied twice.
  const all = [...hunksOurs, ...hunksTheirs].sort((a, b) => b.start - a.start);
  const seen = new Set<string>();
  const result = [...baseLines];
  for (const h of all) {
    const key = `${h.start}:${h.end}:${h.replacement.join('\n')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.splice(h.start, h.end - h.start, ...h.replacement);
  }
  return joinLines(result, base);
}

function splitLines(buf: Buffer): string[] {
  const text = buf.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  // Keep the trailing-newline structure: a file ending in "\n" splits into an
  // extra "" element; drop it and remember the file ends with a newline.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function joinLines(lines: string[], original: Buffer): Buffer {
  if (lines.length === 0) return Buffer.alloc(0);
  const text = lines.join('\n');
  const endsWithNewline = original.length === 0 || original[original.length - 1] === 0x0a;
  return Buffer.from(endsWithNewline ? text + '\n' : text, 'utf8');
}

interface Hunk {
  start: number;
  end: number; // exclusive, in base lines
  replacement: string[];
}

/** Minimal diff hunks from base lines to new lines (LCS-based, O(n*m) — fine for
 *  the small files in this suite). */
export function diffHunks(baseLines: string[], newLines: string[]): Hunk[] {
  const n = baseLines.length;
  const m = newLines.length;
  // LCS table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = baseLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Walk the LCS to emit edit operations.
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let current: Hunk | null = null;
  const flush = () => {
    if (current) {
      hunks.push(current);
      current = null;
    }
  };
  while (i < n || j < m) {
    if (i < n && j < m && baseLines[i] === newLines[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
      // Insert newLines[j].
      if (!current) current = { start: i, end: i, replacement: [] };
      current.replacement.push(newLines[j]);
      j++;
    } else {
      // Delete baseLines[i].
      if (!current) current = { start: i, end: i, replacement: [] };
      current.end = i + 1;
      i++;
    }
  }
  flush();
  return hunks;
}

// -------------------------------------------------------------------------------------------
// Forge store: repositories, issues, pull requests, labels, comments
// -------------------------------------------------------------------------------------------

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: number;
  updatedAt: number;
  user: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: number;
  user: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: number;
  updatedAt: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  comments: Map<number, Comment[]>;
  nextIssue: number;
  nextPull: number;
  nextCommentId: number;
}

export const SCENARIO_EPOCH = 1735689600;

/** Derive the token owner's login from the token itself when it carries one:
 *  a bare login, a JWT with a login claim, or a base64 login. Null when the
 *  token is opaque — the login is then learned from the first owner-named URL. */
export function deriveLoginFromToken(token: string): string | null {
  const t = token.trim();
  if (!t) return null;
  const loginRe = /^[A-Za-z0-9]([A-Za-z0-9-]{0,38})$/;
  if (loginRe.test(t) && !/^[0-9a-f]{40}$/.test(t) && t.length >= 2) return t;
  // JWT: header.payload.signature — look for a login-ish claim in the payload.
  const jwtParts = t.split('.');
  if (jwtParts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(jwtParts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
      for (const key of ['login', 'username', 'user', 'sub']) {
        const v = payload[key];
        if (typeof v === 'string' && loginRe.test(v)) return v;
      }
    } catch {
      // Not a decodable JWT.
    }
  }
  // Base64 that decodes to a login.
  try {
    if (/^[A-Za-z0-9+/=]+$/.test(t) && t.length >= 4) {
      const decoded = Buffer.from(t, 'base64').toString('utf8');
      if (loginRe.test(decoded) && decoded.length >= 2) return decoded;
    }
  } catch {
    // Not base64.
  }
  return null;
}

export class Forge {
  readonly token: string;
  viewerLogin: string | null;
  /** True once an owner-named URL has fixed the viewer login. The first such
   *  URL always names the viewer (the suite uses the stranger only afterwards),
   *  so it overrides any guess derived from the token. */
  private ownerLearned = false;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private requestSeq = 0;
  private commitClock = SCENARIO_EPOCH;

  constructor(token: string) {
    this.token = token;
    this.viewerLogin = deriveLoginFromToken(token);
  }

  /** A fresh per-request id for X-GitHub-Request-Id. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `forge-${Date.now().toString(36)}-${this.requestSeq.toString(36)}`;
  }

  /** Monotonic timestamp (seconds) for server-made commits. */
  nextTimestamp(): number {
    this.commitClock += 1;
    return this.commitClock;
  }

  viewer(): { login: string; id: number; name: string; email: string } {
    const login = this.viewerLogin ?? 'viewer';
    return { login, id: 1000, name: login, email: `${login}@users.noreply.github.com` };
  }

  /** Learn the viewer login from an owner-named URL (first sighting wins). */
  learnOwner(login: string): void {
    if (this.ownerLearned) return;
    this.ownerLearned = true;
    if (this.viewerLogin !== login) {
      this.viewerLogin = login;
      for (const repo of this.repos.values()) repo.owner = login;
    }
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const owner = this.viewerLogin ?? 'viewer';
    const now = Math.floor(Date.now() / 1000);
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      comments: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextCommentId: 1,
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepoByName(name: string): Repo | null {
    const exact = this.repos.get(name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    for (const repo of this.repos.values()) {
      if (repo.name.toLowerCase() === lower) return repo;
    }
    return null;
  }

  /** Look a repo up by (owner, name). Learns the viewer login on first sight.
   *  Returns null when the owner is not the token's user (404, never 403). */
  getRepo(owner: string, name: string): Repo | null {
    const repo = this.getRepoByName(name);
    if (!repo) return null;
    if (!this.ownerLearned) this.learnOwner(owner);
    if (owner !== this.viewerLogin) return null;
    return repo;
  }

  /** Resolve a branch name or full ref to its oid. Returns null when missing. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    return repo.refs.get(`refs/heads/${ref}`) ?? null;
  }

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The commit object for a branch tip (or any oid). */
  commitOf(repo: Repo, oid: string): CommitInfo | null {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data);
  }

  /** Create a commit on a branch from a file change. Returns the commit oid. */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): string {
    const v = this.viewer();
    const ts = this.nextTimestamp();
    const identity = `${v.name} <${v.email}> ${ts} +0000`;
    const tip = this.branchTip(repo, branch);
    const baseTree = tip ? (this.commitOf(repo, tip)?.tree ?? ZERO_OID) : ZERO_OID;
    const { oid: blobOid, object: blob } = makeBlob(content);
    repo.objects.set(blobOid, blob);
    const treeOid = updateTree(repo.objects, baseTree, path, blobOid);
    const commitData = buildCommit({
      tree: treeOid,
      parents: tip ? [tip] : [],
      author: identity,
      committer: identity,
      message,
    });
    const commitOid = objectId('commit', commitData);
    repo.objects.set(commitOid, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.updatedAt = Math.floor(Date.now() / 1000);
    return commitOid;
  }

  /** Delete a file on a branch (commit). Returns the commit oid. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string {
    const v = this.viewer();
    const ts = this.nextTimestamp();
    const identity = `${v.name} <${v.email}> ${ts} +0000`;
    const tip = this.branchTip(repo, branch);
    const baseTree = tip ? (this.commitOf(repo, tip)?.tree ?? ZERO_OID) : ZERO_OID;
    const treeOid = updateTree(repo.objects, baseTree, path, null);
    const commitData = buildCommit({
      tree: treeOid,
      parents: tip ? [tip] : [],
      author: identity,
      committer: identity,
      message,
    });
    const commitOid = objectId('commit', commitData);
    repo.objects.set(commitOid, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.updatedAt = Math.floor(Date.now() / 1000);
    return commitOid;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    // Monotonic timestamps: the suite sorts issues by created_at, so two issues
    // created in the same wall-clock second must still order by creation.
    const now = this.nextTimestamp();
    const issue: Issue = {
      number: repo.nextIssue++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdAt: now,
      updatedAt: now,
      user: this.viewer().login,
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): Pull {
    const now = this.nextTimestamp();
    const headSha = this.resolveRef(repo, headRef) ?? ZERO_OID;
    const baseSha = this.resolveRef(repo, baseRef) ?? ZERO_OID;
    const pull: Pull = {
      number: repo.nextPull++,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.push(pull);
    return pull;
  }

  /** Mergeability of a pull: clean 3-way merge -> MERGEABLE, conflict -> CONFLICTING. */
  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
    const baseSha = this.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
    const headSha = this.resolveRef(repo, pull.headRef) ?? pull.headSha;
    if (!baseSha || baseSha === ZERO_OID || !headSha || headSha === ZERO_OID) return 'UNKNOWN';
    if (baseSha === headSha) return 'MERGEABLE';
    // Fast-forward or already merged.
    if (isAncestor(repo.objects, baseSha, headSha)) return 'MERGEABLE';
    if (isAncestor(repo.objects, headSha, baseSha)) return 'MERGEABLE';
    const mergeBase = findMergeBase(repo.objects, baseSha, headSha);
    if (!mergeBase) return 'UNKNOWN';
    const baseCommit = this.commitOf(repo, mergeBase);
    const baseTree = baseCommit?.tree ?? ZERO_OID;
    const oursTree = this.commitOf(repo, baseSha)?.tree ?? ZERO_OID;
    const theirsTree = this.commitOf(repo, headSha)?.tree ?? ZERO_OID;
    const result = threeWayMerge(repo.objects, baseTree, oursTree, theirsTree);
    return result.conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** Attempt to merge a pull. Returns the merge commit oid, or null on conflict. */
  mergePull(repo: Repo, pull: Pull): string | null {
    const baseSha = this.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
    const headSha = this.resolveRef(repo, pull.headRef) ?? pull.headSha;
    if (!baseSha || baseSha === ZERO_OID || !headSha || headSha === ZERO_OID) return null;
    const v = this.viewer();
    const ts = this.nextTimestamp();
    const identity = `${v.name} <${v.email}> ${ts} +0000`;
    let treeOid: string;
    if (baseSha === headSha || isAncestor(repo.objects, baseSha, headSha)) {
      // Fast-forward: the base just moves to the head.
      treeOid = this.commitOf(repo, headSha)?.tree ?? ZERO_OID;
      repo.refs.set(`refs/heads/${pull.baseRef}`, headSha);
    } else if (isAncestor(repo.objects, headSha, baseSha)) {
      treeOid = this.commitOf(repo, baseSha)?.tree ?? ZERO_OID;
    } else {
      const mergeBase = findMergeBase(repo.objects, baseSha, headSha);
      if (!mergeBase) return null;
      const baseTree = this.commitOf(repo, mergeBase)?.tree ?? ZERO_OID;
      const oursTree = this.commitOf(repo, baseSha)?.tree ?? ZERO_OID;
      const theirsTree = this.commitOf(repo, headSha)?.tree ?? ZERO_OID;
      const result = threeWayMerge(repo.objects, baseTree, oursTree, theirsTree);
      if (result.conflicts.length > 0 || result.treeOid === null) return null;
      treeOid = result.treeOid;
    }
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n`;
    const commitData = buildCommit({
      tree: treeOid,
      parents: [baseSha, headSha],
      author: identity,
      committer: identity,
      message,
    });
    const commitOid = objectId('commit', commitData);
    repo.objects.set(commitOid, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = new Date(ts * 1000).toISOString();
    pull.mergeCommitSha = commitOid;
    pull.updatedAt = Math.floor(Date.now() / 1000);
    repo.updatedAt = Math.floor(Date.now() / 1000);
    return commitOid;
  }
}

/** Opaque, stable GraphQL global id. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

/** Decode a GraphQL global id back to its kind + parts. */
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}
