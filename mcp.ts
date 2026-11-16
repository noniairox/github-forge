// mcp.ts — Model Context Protocol over streamable HTTP (legacy initialize era).
// No server/discover (pre-discover revision passes); initialize, tools/list,
// tools/call. Node 22 stdlib only.
import type { ServerResponse } from 'node:http';
import type { Req } from './app.ts';
import { sendJson, isAuthenticated } from './app.ts';
import type { Forge, Repo } from './store.ts';

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

// The six tools the suite requires, with the canonical argument names
// github-mcp-server uses. Defined once so tools/list is byte-identical.
const TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolTextResult(text: string, isError = false): Record<string, unknown> {
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
  };
  if (isError) result.isError = true;
  return result;
}

function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    // Unknown tool: the caller turns this into a JSON-RPC -32602.
    return { __unknownTool: true } as unknown as Record<string, unknown>;
  }
  // Missing required arguments -> isError result naming the property.
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolTextResult(`Missing required argument: ${required}`, true);
    }
  }
  const str = (v: unknown): string => String(v ?? '');
  if (name === 'create_repo') {
    const repoName = str(args.name);
    const existing = forge.getRepoByName(repoName);
    if (existing) {
      return toolTextResult(JSON.stringify({ error: 'Repository already exists', name: repoName }), true);
    }
    const repo = forge.createRepo(repoName, str(args.description), args.private === true);
    return toolTextResult(JSON.stringify(repoJson(forge, repo)));
  }
  // The remaining tools all need an existing repo.
  const owner = str(args.owner);
  const repoName = str(args.repo);
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    return toolTextResult(JSON.stringify({ error: 'Not Found', owner, repo: repoName }), true);
  }
  if (name === 'get_repo') {
    return toolTextResult(JSON.stringify(repoJson(forge, repo)));
  }
  if (name === 'create_issue') {
    const issue = forge.createIssue(repo, str(args.title), str(args.body), []);
    return toolTextResult(JSON.stringify({
      id: repo.id * 1_000_000 + issue.number,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      repository: `${repo.owner}/${repo.name}`,
    }));
  }
  if (name === 'list_issues') {
    let list = [...repo.issues];
    const state = str(args.state);
    if (state && state !== 'all') list = list.filter((i) => i.state === state);
    return toolTextResult(JSON.stringify(list.map((i) => ({
      id: repo.id * 1_000_000 + i.number,
      number: i.number,
      title: i.title,
      body: i.body,
      state: i.state,
      labels: i.labels,
    }))));
  }
  if (name === 'create_pull_request') {
    const head = str(args.head);
    const base = str(args.base);
    if (!forge.resolveRef(repo, head) || !forge.resolveRef(repo, base)) {
      return toolTextResult(JSON.stringify({ error: 'head or base branch does not exist' }), true);
    }
    const pull = forge.createPull(repo, str(args.title), '', head, base);
    return toolTextResult(JSON.stringify({
      id: repo.id * 1_000_000 + pull.number,
      number: pull.number,
      pull_number: pull.number,
      title: pull.title,
      state: pull.state,
      head: pull.headRef,
      base: pull.baseRef,
      headRefName: pull.headRef,
      baseRefName: pull.baseRef,
      repository: `${repo.owner}/${repo.name}`,
    }));
  }
  if (name === 'merge_pull_request') {
    const number = Number(args.pull_number);
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) {
      return toolTextResult(JSON.stringify({ error: 'Pull request not found', pull_number: number }), true);
    }
    if (pull.merged || pull.state === 'closed') {
      return toolTextResult(JSON.stringify({ error: 'Pull request already merged or closed', pull_number: number }), true);
    }
    const mergedSha = forge.mergePull(repo, pull);
    if (!mergedSha) {
      return toolTextResult(JSON.stringify({ error: 'Merge conflict', pull_number: number }), true);
    }
    return toolTextResult(JSON.stringify({
      merged: true,
      sha: mergedSha,
      number: pull.number,
      pull_number: pull.number,
      state: pull.state,
    }));
  }
  return toolTextResult(JSON.stringify({ error: `Unknown tool: ${name}` }), true);
}

export async function handleMcp(req: Req, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, req, 405, { message: 'Method Not Allowed' });
    return;
  }
  let body: JsonRpcRequest;
  try {
    body = JSON.parse(req.body.toString('utf8')) as JsonRpcRequest;
  } catch {
    // Parse error: HTTP 400 with JSON-RPC -32700.
    res.writeHead(400, { 'content-type': 'application/json', 'x-github-request-id': req.requestId });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }
  const method = typeof body.method === 'string' ? body.method : '';
  const id = body.id ?? null;
  const isNotification = body.id === undefined || body.id === null;
  // Notifications (no id): accept with 202 and no body.
  if (isNotification) {
    res.writeHead(202, { 'x-github-request-id': req.requestId });
    res.end();
    return;
  }
  // tools/call requires auth (checked before the tool exists).
  if (method === 'tools/call' && !isAuthenticated(req)) {
    sendJson(res, req, 401, { message: 'Requires authentication' });
    return;
  }
  const params = (body.params ?? {}) as Record<string, unknown>;
  if (method === 'server/discover') {
    // Pre-discover revision: method not found, so the client falls back to
    // the legacy initialize flow.
    sendJson(res, req, 200, rpcError(id, -32601, 'Method not found: server/discover'));
    return;
  }
  if (method === 'initialize') {
    const offered = typeof (params.protocolVersion as unknown) === 'string' ? (params.protocolVersion as string) : '';
    const protocolVersion = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-11-25';
    sendJson(res, req, 200, rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    }));
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, req, 200, rpcResult(id, { tools: TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const result = callTool(req.forge, toolName, args);
    if ((result as { __unknownTool?: boolean }).__unknownTool) {
      sendJson(res, req, 200, rpcError(id, -32602, `Unknown tool: ${toolName}`));
      return;
    }
    sendJson(res, req, 200, rpcResult(id, result));
    return;
  }
  if (method === 'ping') {
    sendJson(res, req, 200, rpcResult(id, {}));
    return;
  }
  sendJson(res, req, 200, rpcError(id, -32601, `Method not found: ${method}`));
}
