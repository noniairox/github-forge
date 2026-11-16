// rest.ts — GitHub REST v3 API: repos, branches, commits, contents, issues,
// comments, labels, pull requests. Node 22 stdlib only.
import type { ServerResponse } from 'node:http';
import type { Req } from './app.ts';
import { sendJson, isAuthenticated } from './app.ts';
import {
  ZERO_OID,
  SCENARIO_EPOCH,
  parseCommit,
  parseTree,
  flattenTree,
  getBlobAt,
  diffHunks,
} from './store.ts';
import type { Forge, Repo, Issue, Pull, Label, Comment } from './store.ts';

const INSTALLED_VERSION = 'forge-1.0.0';

// -------------------------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------------------------

function parseJsonBody(req: Req): { ok: true; value: unknown } | { ok: false } {
  if (req.body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(req.body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? parseInt(value, 10) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function iso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\n\r\t ]/g, ''), 'base64');
}

/** Build a same-origin absolute URL for pagination Link headers. */
function absoluteUrl(req: Req, pathname: string, query: URLSearchParams): string {
  const host = req.headers.host ?? 'localhost';
  const qs = query.toString();
  return `http://${host}${pathname}${qs ? `?${qs}` : ''}`;
}

/** Paginate a list: returns the page slice and a Link header (rel=next/prev/first/last). */
function paginate<T>(
  req: Req,
  items: T[],
  defaultPerPage = 30,
): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, num(req.query.get('per_page'), defaultPerPage)));
  const pageNum = Math.max(1, num(req.query.get('page'), 1));
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const links: string[] = [];
  const make = (page: number, rel: string): string => {
    const q = new URLSearchParams(req.query);
    q.set('per_page', String(perPage));
    q.set('page', String(page));
    return `<${absoluteUrl(req, req.pathname, q)}>; rel="${rel}"`;
  };
  if (pageNum < totalPages) links.push(make(pageNum + 1, 'next'));
  if (pageNum > 1) links.push(make(pageNum - 1, 'prev'));
  links.push(make(1, 'first'));
  links.push(make(totalPages, 'last'));
  return { page, link: links.length > 0 ? links.join(', ') : null };
}

// -------------------------------------------------------------------------------------------
// serializers
// -------------------------------------------------------------------------------------------

function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const v = forge.viewer();
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: iso(repo.createdAt),
    updated_at: iso(repo.updatedAt),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    fork: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    watchers_count: 0,
    size: 0,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    pushed_at: iso(repo.updatedAt),
  };
}

function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  const v = forge.viewer();
  return {
    id: repo.id * 1_000_000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.find((l) => l.name === name);
      return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    user: { login: issue.user, id: 1000, type: 'User' },
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.updatedAt),
    closed_at: issue.state === 'closed' ? iso(issue.updatedAt) : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    comments: (repo.comments.get(issue.number) ?? []).length,
    state_reason: null,
  };
}

function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const v = forge.viewer();
  return {
    id: repo.id * 1_000_000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: forge.mergeable(repo, pull),
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: { login: repo.owner, id: 1000, type: 'User' },
      repo: repoJson(forge, repo),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: { login: repo.owner, id: 1000, type: 'User' },
      repo: repoJson(forge, repo),
    },
    user: { login: v.login, id: 1000, type: 'User' },
    created_at: iso(pull.createdAt),
    updated_at: iso(pull.updatedAt),
    closed_at: pull.state === 'closed' ? iso(pull.updatedAt) : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function commentJson(forge: Forge, repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.user, id: 1000, type: 'User' },
    created_at: iso(comment.createdAt),
    updated_at: iso(comment.createdAt),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    issue_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description ?? '' };
}

// -------------------------------------------------------------------------------------------
// router
// -------------------------------------------------------------------------------------------

export async function handleRest(req: Req, res: ServerResponse): Promise<void> {
  const forge = req.forge;
  // Auth: every REST endpoint requires the trial token.
  if (!isAuthenticated(req)) {
    sendJson(res, req, 401, { message: 'Requires authentication' });
    return;
  }
  // Parse the path after /api/v3.
  const rest = req.pathname === '/api/v3' ? '/' : req.pathname.slice('/api/v3'.length);
  const segments = rest.split('/').filter((s) => s.length > 0).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const method = req.method;

  // GET /api/v3/ — API root.
  if (segments.length === 0 && method === 'GET') {
    sendJson(res, req, 200, {
      current_user_url: 'https://api.github.com/user',
      repository_url: 'https://api.github.com/repos/{owner}/{repo}',
      user_url: 'https://api.github.com/users/{user}',
      rate_limit_url: 'https://api.github.com/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  // GET /api/v3/meta.
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    sendJson(res, req, 200, { installed_version: INSTALLED_VERSION });
    return;
  }
  // GET /api/v3/user.
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    const v = forge.viewer();
    sendJson(res, req, 200, {
      login: v.login, id: v.id, name: v.name, email: v.email, type: 'User',
      html_url: `https://github.com/${v.login}`,
      created_at: iso(SCENARIO_EPOCH),
      updated_at: iso(SCENARIO_EPOCH),
    });
    return;
  }
  // POST /api/v3/user/repos + GET /api/v3/user/repos.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, req, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const body = asRecord(parsed.value);
      const name = str(body.name);
      if (!name) {
        sendJson(res, req, 422, { message: 'name is required' });
        return;
      }
      const existing = forge.getRepoByName(name);
      if (existing) {
        sendJson(res, req, 422, { message: 'Repository already exists' });
        return;
      }
      const repo = forge.createRepo(name, str(body.description), bool(body.private, false));
      sendJson(res, req, 201, repoJson(forge, repo));
      return;
    }
    if (method === 'GET') {
      const all = [...forge.repos.values()].sort((a, b) => a.id - b.id);
      const { page, link } = paginate(req, all);
      const headers: Record<string, string> = {};
      if (link) headers.link = link;
      sendJson(res, req, 200, page.map((r) => repoJson(forge, r)), headers);
      return;
    }
  }
  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    await handleRepoRoutes(req, res, segments);
    return;
  }
  // Unknown /api/v3 route: JSON 404.
  sendJson(res, req, 404, { message: 'Not Found' });
}

async function handleRepoRoutes(req: Req, res: ServerResponse, segments: string[]): Promise<void> {
  const forge = req.forge;
  const owner = segments[1];
  const repoName = segments[2];
  const repo = forge.getRepo(owner, repoName);
  const method = req.method;
  const rest = segments.slice(3);

  // The repo itself: GET / PATCH / DELETE.
  if (rest.length === 0) {
    if (method === 'GET') {
      if (!repo) {
        sendJson(res, req, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, req, 200, repoJson(forge, repo));
      return;
    }
    if (method === 'PATCH') {
      if (!repo) {
        sendJson(res, req, 404, { message: 'Not Found' });
        return;
      }
      const parsed = parseJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, req, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const body = asRecord(parsed.value);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      repo.updatedAt = Math.floor(Date.now() / 1000);
      sendJson(res, req, 200, repoJson(forge, repo));
      return;
    }
    if (method === 'DELETE') {
      if (!repo) {
        sendJson(res, req, 404, { message: 'Not Found' });
        return;
      }
      forge.repos.delete(repo.name);
      res.writeHead(204, { 'x-github-request-id': req.requestId });
      res.end();
      return;
    }
  }
  if (!repo) {
    sendJson(res, req, 404, { message: 'Not Found' });
    return;
  }
  if (rest[0] === 'branches') return handleBranches(req, res, repo, rest.slice(1));
  if (rest[0] === 'git' && rest[1] === 'refs') return handleGitRefs(req, res, repo, rest.slice(2));
  if (rest[0] === 'commits') return handleCommits(req, res, repo);
  if (rest[0] === 'contents') return handleContents(req, res, repo, rest.slice(1));
  if (rest[0] === 'labels') return handleLabels(req, res, repo);
  if (rest[0] === 'issues') return handleIssues(req, res, repo, rest.slice(1));
  if (rest[0] === 'pulls') return handlePulls(req, res, repo, rest.slice(1));
  sendJson(res, req, 404, { message: 'Not Found' });
}

// -------------------------------------------------------------------------------------------
// branches / git refs / commits
// -------------------------------------------------------------------------------------------

function handleBranches(req: Req, res: ServerResponse, repo: Repo, rest: string[]): void {
  const forge = req.forge;
  const method = req.method;
  if (rest.length === 0 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid, url: '' } }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const { page, link } = paginate(req, branches);
    const headers: Record<string, string> = {};
    if (link) headers.link = link;
    sendJson(res, req, 200, page, headers);
    return;
  }
  if (rest.length === 1 && method === 'GET') {
    const oid = repo.refs.get(`refs/heads/${rest[0]}`);
    if (!oid) {
      sendJson(res, req, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, req, 200, { name: rest[0], commit: { sha: oid, url: '' }, protected: false });
    return;
  }
  sendJson(res, req, 404, { message: 'Not Found' });
}

function handleGitRefs(req: Req, res: ServerResponse, repo: Repo, rest: string[]): void {
  const method = req.method;
  // POST /git/refs — create a branch (or tag) ref.
  if (rest.length === 0 && method === 'POST') {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, req, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const body = asRecord(parsed.value);
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
      sendJson(res, req, 422, { message: 'Invalid ref or sha' });
      return;
    }
    if (!repo.objects.has(sha)) {
      sendJson(res, req, 422, { message: 'Object does not exist' });
      return;
    }
    repo.refs.set(ref, sha);
    sendJson(res, req, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' }, url: '' });
    return;
  }
  // GET /git/refs/heads/{branch} — read one ref.
  if (rest.length >= 2 && rest[0] === 'heads' && method === 'GET') {
    const branch = rest.slice(1).join('/');
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (!oid) {
      sendJson(res, req, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, req, 200, { ref: `refs/heads/${branch}`, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit', url: '' }, url: '' });
    return;
  }
  sendJson(res, req, 404, { message: 'Not Found' });
}

function commitJson(forge: Forge, repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const info = parseCommit(obj.data);
  const v = forge.viewer();
  const authorLine = (line: string): { name: string; email: string; date: string } => {
    // "Name <email> ts +0000"
    const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!m) return { name: v.name, email: v.email, date: iso(SCENARIO_EPOCH) };
    return { name: m[1], email: m[2], date: iso(Number(m[3])) };
  };
  const author = authorLine(info.author);
  const committer = authorLine(info.committer);
  return {
    sha: oid,
    commit: {
      message: info.message,
      author,
      committer,
      tree: { sha: info.tree, url: '' },
    },
    author: { login: v.login, id: 1000, type: 'User' },
    committer: { login: v.login, id: 1000, type: 'User' },
    parents: info.parents.map((p) => ({ sha: p, url: '' })),
    url: '',
  };
}

function handleCommits(req: Req, res: ServerResponse, repo: Repo): void {
  if (req.method !== 'GET') {
    sendJson(res, req, 404, { message: 'Not Found' });
    return;
  }
  const forge = req.forge;
  const shaParam = req.query.get('sha');
  const tip = shaParam
    ? (forge.resolveRef(repo, shaParam) ?? (/^[0-9a-f]{40}$/.test(shaParam) ? shaParam : null))
    : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (!tip || tip === ZERO_OID) {
    sendJson(res, req, 200, []);
    return;
  }
  // First-parent walk from the tip.
  const commits: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let current: string | null = tip;
  while (current && !seen.has(current)) {
    seen.add(current);
    const json = commitJson(forge, repo, current);
    if (!json) break;
    commits.push(json);
    const info = parseCommit(repo.objects.get(current)!.data);
    current = info.parents.length > 0 ? info.parents[0] : null;
  }
  const { page, link } = paginate(req, commits);
  const headers: Record<string, string> = {};
  if (link) headers.link = link;
  sendJson(res, req, 200, page, headers);
}

// -------------------------------------------------------------------------------------------
// contents
// -------------------------------------------------------------------------------------------

function handleContents(req: Req, res: ServerResponse, repo: Repo, rest: string[]): void {
  const forge = req.forge;
  const method = req.method;
  const path = rest.join('/');
  if (!path) {
    sendJson(res, req, 404, { message: 'Not Found' });
    return;
  }
  const refParam = req.query.get('ref');
  const branch = refParam ?? repo.defaultBranch;
  if (method === 'GET') {
    const tip = forge.branchTip(repo, branch);
    if (!tip) {
      sendJson(res, req, 404, { message: 'Not Found' });
      return;
    }
    const treeOid = forge.commitOf(repo, tip)?.tree ?? ZERO_OID;
    const blob = getBlobAt(repo.objects, treeOid, path);
    if (blob) {
      sendJson(res, req, 200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: b64encode(blob.data),
        sha: blob.oid,
        url: '',
        git_url: '',
        html_url: '',
        download_url: '',
      });
      return;
    }
    // Directory listing?
    const flat = flattenTree(repo.objects, treeOid);
    const dirPrefix = path.endsWith('/') ? path : path + '/';
    const entries: Array<Record<string, unknown>> = [];
    const seenDirs = new Set<string>();
    for (const f of flat) {
      if (!f.path.startsWith(dirPrefix)) continue;
      const restPath = f.path.slice(dirPrefix.length);
      const slash = restPath.indexOf('/');
      if (slash < 0) {
        entries.push({ type: 'file', name: restPath, path: f.path, sha: f.oid, size: repo.objects.get(f.oid)?.data.length ?? 0, url: '' });
      } else {
        const dirName = restPath.slice(0, slash);
        if (!seenDirs.has(dirName)) {
          seenDirs.add(dirName);
          entries.push({ type: 'dir', name: dirName, path: dirPrefix + dirName, sha: '', size: 0, url: '' });
        }
      }
    }
    // A bare directory with no files directly under it still lists if the path
    // is a directory in the tree (check by walking the tree).
    if (entries.length === 0) {
      const dirOid = treeOidAtPath(repo, treeOid, path);
      if (dirOid === null) {
        sendJson(res, req, 404, { message: 'Not Found' });
        return;
      }
      for (const e of parseTree(repo.objects.get(dirOid)!.data)) {
        entries.push({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: dirPrefix + e.name, sha: e.oid, size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0), url: '' });
      }
    }
    entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    sendJson(res, req, 200, entries);
    return;
  }
  if (method === 'PUT') {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, req, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const body = asRecord(parsed.value);
    const contentB64 = str(body.content);
    const message = str(body.message, 'Update file');
    const shaParam = typeof body.sha === 'string' ? body.sha : undefined;
    const putBranch = typeof body.branch === 'string' ? body.branch : branch;
    const content = contentB64 ? b64decode(contentB64) : Buffer.alloc(0);
    const tip = forge.branchTip(repo, putBranch);
    const treeOid = tip ? (forge.commitOf(repo, tip)?.tree ?? ZERO_OID) : ZERO_OID;
    const existing = getBlobAt(repo.objects, treeOid, path);
    if (existing) {
      // Update: the caller must send the current blob sha.
      if (shaParam !== undefined && shaParam !== existing.oid) {
        sendJson(res, req, 409, { message: 'sha does not match' });
        return;
      }
      const commitOid = forge.commitFile(repo, putBranch, path, content, message);
      const newBlob = getBlobAt(repo.objects, forge.commitOf(repo, commitOid)?.tree ?? ZERO_OID, path);
      sendJson(res, req, 200, {
        content: { sha: newBlob?.oid ?? '', encoding: 'base64', size: content.length, name: path.split('/').pop() ?? path, path },
        commit: { sha: commitOid, message },
      });
      return;
    }
    // Create.
    const commitOid = forge.commitFile(repo, putBranch, path, content, message);
    const newBlob = getBlobAt(repo.objects, forge.commitOf(repo, commitOid)?.tree ?? ZERO_OID, path);
    sendJson(res, req, 201, {
      content: { sha: newBlob?.oid ?? '', encoding: 'base64', size: content.length, name: path.split('/').pop() ?? path, path },
      commit: { sha: commitOid, message },
    });
    return;
  }
  if (method === 'DELETE') {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, req, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const body = asRecord(parsed.value);
    const message = str(body.message, 'Delete file');
    const shaParam = typeof body.sha === 'string' ? body.sha : undefined;
    const delBranch = typeof body.branch === 'string' ? body.branch : branch;
    const tip = forge.branchTip(repo, delBranch);
    if (!tip) {
      sendJson(res, req, 404, { message: 'Not Found' });
      return;
    }
    const treeOid = forge.commitOf(repo, tip)?.tree ?? ZERO_OID;
    const existing = getBlobAt(repo.objects, treeOid, path);
    if (!existing) {
      sendJson(res, req, 404, { message: 'Not Found' });
      return;
    }
    if (shaParam !== undefined && shaParam !== existing.oid) {
      sendJson(res, req, 409, { message: 'sha does not match' });
      return;
    }
    const commitOid = forge.deleteFile(repo, delBranch, path, message);
    sendJson(res, req, 200, { commit: { sha: commitOid, message } });
    return;
  }
  sendJson(res, req, 404, { message: 'Not Found' });
}

/** The tree oid of a directory path (null when the path is not a directory). */
function treeOidAtPath(repo: Repo, treeOid: string, path: string): string | null {
  const parts = path.split('/').filter((p) => p.length > 0);
  let current = treeOid;
  for (const part of parts) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

// -------------------------------------------------------------------------------------------
// labels
// -------------------------------------------------------------------------------------------

function handleLabels(req: Req, res: ServerResponse, repo: Repo): void {
  const method = req.method;
  if (method === 'GET') {
    sendJson(res, req, 200, repo.labels.map(labelJson));
    return;
  }
  if (method === 'POST') {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, req, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const body = asRecord(parsed.value);
    const name = str(body.name);
    const color = str(body.color, 'ededed').replace(/^#/, '');
    if (!name) {
      sendJson(res, req, 422, { message: 'name is required' });
      return;
    }
    const existing = repo.labels.find((l) => l.name === name);
    if (existing) {
      sendJson(res, req, 200, labelJson(existing));
      return;
    }
    const label: Label = { name, color, description: str(body.description) };
    repo.labels.push(label);
    sendJson(res, req, 201, labelJson(label));
    return;
  }
  sendJson(res, req, 404, { message: 'Not Found' });
}

// -------------------------------------------------------------------------------------------
// issues + comments
// -------------------------------------------------------------------------------------------

function handleIssues(req: Req, res: ServerResponse, repo: Repo, rest: string[]): void {
  const forge = req.forge;
  const method = req.method;
  // /issues — list or create.
  if (rest.length === 0) {
    if (method === 'GET') {
      let list = [...repo.issues];
      const state = req.query.get('state');
      if (state && state !== 'all') list = list.filter((i) => i.state === state);
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      if (sort === 'created') {
        list.sort((a, b) => {
          if (a.createdAt !== b.createdAt) return direction === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
          return direction === 'asc' ? a.number - b.number : b.number - a.number;
        });
      }
      const { page, link } = paginate(req, list);
      const headers: Record<string, string> = {};
      if (link) headers.link = link;
      sendJson(res, req, 200, page.map((i) => issueJson(forge, repo, i)), headers);
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, req, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const body = asRecord(parsed.value);
      const title = str(body.title);
      const issueBody = str(body.body);
      const labelsRaw = Array.isArray(body.labels) ? body.labels : [];
      const labels: string[] = [];
      for (const l of labelsRaw) {
        const name = typeof l === 'string' ? l : str((l as Record<string, unknown>)?.name);
        if (!name) continue;
        if (!repo.labels.some((x) => x.name === name)) {
          sendJson(res, req, 422, { message: `Label '${name}' does not exist` });
          return;
        }
        labels.push(name);
      }
      const issue = forge.createIssue(repo, title, issueBody, labels);
      sendJson(res, req, 201, issueJson(forge, repo, issue));
      return;
    }
  }
  // /issues/{number} — get or patch.
  if (rest.length === 1) {
    const number = parseInt(rest[0], 10);
    const issue = repo.issues.find((i) => i.number === number);
    if (!issue) {
      sendJson(res, req, 404, { message: 'Not Found' });
      return;
    }
    if (method === 'GET') {
      sendJson(res, req, 200, issueJson(forge, repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, req, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const body = asRecord(parsed.value);
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
        issue.state = body.state;
      }
      if (Array.isArray(body.labels)) {
        const labels: string[] = [];
        for (const l of body.labels) {
          const name = typeof l === 'string' ? l : str((l as Record<string, unknown>)?.name);
          if (name) labels.push(name);
        }
        issue.labels = labels;
      }
      issue.updatedAt = forge.nextTimestamp();
      sendJson(res, req, 200, issueJson(forge, repo, issue));
      return;
    }
  }
  // /issues/{number}/comments — list or create.
  if (rest.length === 2 && rest[1] === 'comments') {
    const number = parseInt(rest[0], 10);
    const issue = repo.issues.find((i) => i.number === number);
    if (!issue) {
      sendJson(res, req, 404, { message: 'Not Found' });
      return;
    }
    if (method === 'GET') {
      const list = repo.comments.get(number) ?? [];
      const { page, link } = paginate(req, list);
      const headers: Record<string, string> = {};
      if (link) headers.link = link;
      sendJson(res, req, 200, page.map((c) => commentJson(forge, repo, number, c)), headers);
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, req, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const body = asRecord(parsed.value);
      const comment: Comment = {
        id: repo.nextCommentId++,
        body: str(body.body),
        createdAt: forge.nextTimestamp(),
        user: forge.viewer().login,
      };
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      sendJson(res, req, 201, commentJson(forge, repo, number, comment));
      return;
    }
  }
  sendJson(res, req, 404, { message: 'Not Found' });
}

// -------------------------------------------------------------------------------------------
// pull requests
// -------------------------------------------------------------------------------------------

function pullFiles(forge: Forge, repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const baseSha = forge.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
  const headSha = forge.resolveRef(repo, pull.headRef) ?? pull.headSha;
  const baseTree = baseSha && baseSha !== ZERO_OID ? (forge.commitOf(repo, baseSha)?.tree ?? ZERO_OID) : ZERO_OID;
  const headTree = headSha && headSha !== ZERO_OID ? (forge.commitOf(repo, headSha)?.tree ?? ZERO_OID) : ZERO_OID;
  const baseFiles = new Map(flattenTree(repo.objects, baseTree).map((f) => [f.path, f.oid]));
  const headFiles = new Map(flattenTree(repo.objects, headTree).map((f) => [f.path, f.oid]));
  const out: Array<Record<string, unknown>> = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b === h) continue;
    const baseData = b ? (repo.objects.get(b)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const headData = h ? (repo.objects.get(h)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    let status: string;
    let additions = 0;
    let deletions = 0;
    if (b === undefined) {
      status = 'added';
      additions = headData.toString('utf8').split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === '')).length;
    } else if (h === undefined) {
      status = 'removed';
      deletions = baseData.toString('utf8').split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === '')).length;
    } else {
      status = 'modified';
      const baseLines = baseData.toString('utf8').split('\n');
      const headLines = headData.toString('utf8').split('\n');
      if (baseLines.length > 0 && baseLines[baseLines.length - 1] === '') baseLines.pop();
      if (headLines.length > 0 && headLines[headLines.length - 1] === '') headLines.pop();
      const hunks = diffHunks(baseLines, headLines);
      for (const hk of hunks) {
        deletions += hk.end - hk.start;
        additions += hk.replacement.length;
      }
    }
    out.push({
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: h ?? b ?? '',
      blob_url: '',
      raw_url: '',
      contents_url: '',
    });
  }
  return out;
}

function handlePulls(req: Req, res: ServerResponse, repo: Repo, rest: string[]): void {
  const forge = req.forge;
  const method = req.method;
  // /pulls — list or create.
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state');
      let list = [...repo.pulls];
      if (!state || state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      // state=all keeps everything.
      const { page, link } = paginate(req, list);
      const headers: Record<string, string> = {};
      if (link) headers.link = link;
      sendJson(res, req, 200, page.map((p) => pullJson(forge, repo, p)), headers);
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, req, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const body = asRecord(parsed.value);
      const title = str(body.title);
      const pullBody = str(body.body);
      const head = str(body.head);
      const base = str(body.base, repo.defaultBranch);
      if (!head) {
        sendJson(res, req, 422, { message: 'head is required' });
        return;
      }
      if (!forge.resolveRef(repo, head) || !forge.resolveRef(repo, base)) {
        sendJson(res, req, 422, { message: 'head or base branch does not exist' });
        return;
      }
      const pull = forge.createPull(repo, title, pullBody, head, base);
      sendJson(res, req, 201, pullJson(forge, repo, pull));
      return;
    }
  }
  // /pulls/{number} — get.
  if (rest.length === 1 && method === 'GET') {
    const number = parseInt(rest[0], 10);
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) {
      sendJson(res, req, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, req, 200, pullJson(forge, repo, pull));
    return;
  }
  // /pulls/{number}/files — list changed files.
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const number = parseInt(rest[0], 10);
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) {
      sendJson(res, req, 404, { message: 'Not Found' });
      return;
    }
    const files = pullFiles(forge, repo, pull);
    const { page, link } = paginate(req, files);
    const headers: Record<string, string> = {};
    if (link) headers.link = link;
    sendJson(res, req, 200, page, headers);
    return;
  }
  // /pulls/{number}/merge — merge.
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const number = parseInt(rest[0], 10);
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) {
      sendJson(res, req, 404, { message: 'Not Found' });
      return;
    }
    if (pull.merged || pull.state === 'closed') {
      sendJson(res, req, 405, { message: 'Pull request already merged or closed' });
      return;
    }
    const mergedSha = forge.mergePull(repo, pull);
    if (!mergedSha) {
      sendJson(res, req, 405, { message: 'Merge conflict' });
      return;
    }
    sendJson(res, req, 200, {
      sha: mergedSha,
      merged: true,
      message: `Pull request #${pull.number} merged`,
    });
    return;
  }
  sendJson(res, req, 404, { message: 'Not Found' });
}
