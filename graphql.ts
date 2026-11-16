// graphql.ts — GitHub GraphQL v4, targeted at the documents gh and
// github-mcp-server send. A small parser + executor (no dependencies).
import type { ServerResponse } from 'node:http';
import type { Req } from './app.ts';
import { sendJson, isAuthenticated } from './app.ts';
import {
  globalId,
  decodeGlobalId,
  parseTree,
} from './store.ts';
import type { Forge, Repo, Issue, Pull } from './store.ts';

// -------------------------------------------------------------------------------------------
// Lexer + parser (subset: operations, fields, args, variables, inline fragments)
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '#') {
      if (c === '#') {
        while (i < input.length && input[i] !== '\n') i++;
      } else {
        i++;
      }
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!():=@[]{}.|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j++;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c) || c === '$') {
      let j = i;
      if (c === '$') j++;
      while (j < input.length && isNameChar(input[j])) j++;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (input[j] === '-') j++;
      while (j < input.length && /[0-9]/.test(input[j])) j++;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        j++;
        while (j < input.length && /[0-9]/.test(input[j])) j++;
        tokens.push({ kind: 'float', value: input.slice(i, j) });
      } else {
        tokens.push({ kind: 'int', value: input.slice(i, j) });
      }
      i = j;
      continue;
    }
    // Unknown character: skip it.
    i++;
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

export interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  selection: SelectionNode[];
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string | null; selection: SelectionNode[] };

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: string[];
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}`);
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('expected name');
    return t.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const variableDefinitions: string[] = [];
    const t = this.peek();
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      const n = this.peek();
      if (n.kind === 'name') name = this.next().value;
    } else if (t.kind === 'punct' && t.value === '{') {
      // Anonymous shorthand query.
    } else if (t.kind === 'name' && t.value === 'fragment') {
      // Named fragment definition: skip it (not used by the known documents).
      this.next();
      this.expectName();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        this.expectName();
      }
      this.parseSelectionSet();
      return this.parseOperation();
    }
    // Variable definitions.
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const vt = this.next();
        if (vt.kind === 'name' && vt.value.startsWith('$')) variableDefinitions.push(vt.value.slice(1));
        else if (vt.kind === 'punct' && vt.value === ':') {
          // Skip the type (may be [..] or a name with !).
          this.skipType();
        }
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { operation, name, variableDefinitions, selection };
  }

  private skipType(): void {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '[') {
      this.skipType();
      this.expectPunct(']');
    }
    // A trailing ! is consumed by the caller loop.
    while (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      let typeCondition: string | null = null;
      const n = this.peek();
      if (n.kind === 'name' && n.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      const selection = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selection };
    }
    // Field (possibly aliased).
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, unknown> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    let selection: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', field: { alias, name, args, selection } };
  }

  private parseValue(): unknown {
    const t = this.next();
    if (t.kind === 'int') return parseInt(t.value, 10);
    if (t.kind === 'float') return parseFloat(t.value);
    if (t.kind === 'string') return t.value;
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      if (t.value.startsWith('$')) return { __variable: t.value.slice(1) };
      return { __enum: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const list: unknown[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        list.push(this.parseValue());
      }
      this.expectPunct(']');
      return list;
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        obj[key] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    throw new Error('unexpected value token');
  }
}

/** Resolve variables inside an argument value. */
export function resolveValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('__variable' in (value as Record<string, unknown>)) {
      return variables[(value as { __variable: string }).__variable] ?? null;
    }
    if ('__enum' in (value as Record<string, unknown>)) {
      return (value as { __enum: string }).__enum;
    }
    if (Array.isArray(value)) return value.map((v) => resolveValue(v, variables));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveValue(v, variables);
    }
    return out;
  }
  return value;
}

function resolveArgs(args: Record<string, unknown>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = resolveValue(v, variables);
  return out;
}

// -------------------------------------------------------------------------------------------
// Type field lists (for introspection + unknown-field detection)
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest',
    'pullRequests', 'url', 'description', 'isPrivate', 'private', 'createdAt', 'updatedAt',
  ],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'url', 'labels'],
  IssueConnection: ['nodes', 'totalCount', 'pageInfo'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'mergeCommit', 'author',
  ],
  PullRequestConnection: ['nodes', 'totalCount', 'pageInfo'],
  PullRequestFileConnection: ['nodes', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  Comment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name', 'type', 'args'],
  __EnumValue: ['name'],
};

const SEARCH_TYPES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

// -------------------------------------------------------------------------------------------
// Executor
// -------------------------------------------------------------------------------------------

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type NodeValue = { __typename: string; [key: string]: unknown };

function isNode(value: unknown): value is NodeValue {
  return typeof value === 'object' && value !== null && '__typename' in (value as Record<string, unknown>);
}

function executeSelection(
  parent: NodeValue,
  selection: SelectionNode[],
  ctx: ExecContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && sel.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelection(parent, sel.selection, ctx));
      continue;
    }
    const field = sel.field;
    const outName = field.alias ?? field.name;
    const args = resolveArgs(field.args, ctx.variables);
    const value = resolveField(parent, field.name, args, ctx);
    if (value === undefined) {
      // Unknown field for this type: record the error, value is null.
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parent.__typename}".` });
      out[outName] = null;
      continue;
    }
    out[outName] = executeValue(value, field.selection, ctx);
  }
  return out;
}

function executeValue(value: unknown, selection: SelectionNode[], ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => executeValue(v, selection, ctx));
  if (isNode(value)) {
    if (selection.length === 0) return value;
    return executeSelection(value, selection, ctx);
  }
  return value;
}

/** Find a repo by its GraphQL global id. */
function repoByGlobalId(forge: Forge, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const dbId = Number(decoded.parts[0]);
  for (const repo of forge.repos.values()) {
    if (repo.id === dbId) return repo;
  }
  return null;
}

/** Find an issue by its GraphQL global id. */
function issueByGlobalId(forge: Forge, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const repoId = Number(decoded.parts[0]);
  const number = Number(decoded.parts[1]);
  for (const repo of forge.repos.values()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.find((i) => i.number === number);
    if (issue) return { repo, issue };
  }
  return null;
}

/** Find a pull request by its GraphQL global id. */
function pullByGlobalId(forge: Forge, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const repoId = Number(decoded.parts[0]);
  const number = Number(decoded.parts[1]);
  for (const repo of forge.repos.values()) {
    if (repo.id !== repoId) continue;
    const pull = repo.pulls.find((p) => p.number === number);
    if (pull) return { repo, pull };
  }
  return null;
}

function issueNode(repo: Repo, issue: Issue): NodeValue {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): NodeValue {
  return { __typename: 'PullRequest', repo, pull };
}

function repoNode(repo: Repo): NodeValue {
  return { __typename: 'Repository', repo };
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function resolveField(
  parent: NodeValue,
  fieldName: string,
  args: Record<string, unknown>,
  ctx: ExecContext,
): unknown {
  const forge = ctx.forge;
  const known = TYPE_FIELDS[parent.__typename] ?? [];
  // Introspection meta-fields are available on every type.
  if (fieldName === '__typename') return parent.__typename;
  if (fieldName === '__type') {
    const name = String(args.name ?? '');
    if (!TYPE_FIELDS[name] && name !== 'SearchType') return null;
    return { __typename: '__Type', typeName: name };
  }
  if (!known.includes(fieldName)) return undefined;

  switch (parent.__typename) {
    case 'Query': {
      if (fieldName === 'viewer') {
        const v = forge.viewer();
        return { __typename: 'User', login: v.login, id: v.id };
      }
      if (fieldName === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = forge.getRepo(owner, name);
        return repo ? repoNode(repo) : null;
      }
      if (fieldName === 'node') {
        const id = String(args.id ?? '');
        const repo = repoByGlobalId(forge, id);
        if (repo) return repoNode(repo);
        const issue = issueByGlobalId(forge, id);
        if (issue) return issueNode(issue.repo, issue.issue);
        const pull = pullByGlobalId(forge, id);
        if (pull) return pullNode(pull.repo, pull.pull);
        return null;
      }
      break;
    }
    case 'User': {
      if (fieldName === 'login') return parent.login as string;
      if (fieldName === 'id') return parent.id as number;
      if (fieldName === 'name') return parent.login as string;
      if (fieldName === 'email') return `${parent.login as string}@users.noreply.github.com`;
      if (fieldName === 'url') return `https://github.com/${parent.login as string}`;
      break;
    }
    case 'Repository': {
      const repo = parent.repo as Repo;
      if (fieldName === 'id') return globalId('Repository', repo.id);
      if (fieldName === 'databaseId') return repo.id;
      if (fieldName === 'name') return repo.name;
      if (fieldName === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (fieldName === 'owner') {
        return { __typename: 'User', login: repo.owner, id: 1000 };
      }
      if (fieldName === 'defaultBranchRef') {
        return { __typename: 'Ref', name: repo.defaultBranch };
      }
      if (fieldName === 'viewerPermission') return 'ADMIN';
      if (fieldName === 'hasIssuesEnabled') return true;
      if (fieldName === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
      if (fieldName === 'description') return repo.description;
      if (fieldName === 'isPrivate' || fieldName === 'private') return repo.isPrivate;
      if (fieldName === 'createdAt') return new Date(repo.createdAt * 1000).toISOString();
      if (fieldName === 'updatedAt') return new Date(repo.updatedAt * 1000).toISOString();
      if (fieldName === 'issue') {
        const number = Number(args.number);
        const issue = repo.issues.find((i) => i.number === number);
        return issue ? issueNode(repo, issue) : null;
      }
      if (fieldName === 'issues') {
        return issuesConnection(repo, args);
      }
      if (fieldName === 'pullRequest') {
        const number = Number(args.number);
        const pull = repo.pulls.find((p) => p.number === number);
        return pull ? pullNode(repo, pull) : null;
      }
      if (fieldName === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : 100;
        const nodes = repo.pulls.slice(0, first).map((p) => pullNode(repo, p));
        return { __typename: 'PullRequestConnection', nodes, totalCount: repo.pulls.length };
      }
      break;
    }
    case 'Ref': {
      if (fieldName === 'name') return parent.name as string;
      break;
    }
    case 'Issue': {
      const repo = parent.repo as Repo;
      const issue = parent.issue as Issue;
      if (fieldName === 'id') return globalId('Issue', repo.id, issue.number);
      if (fieldName === 'number') return issue.number;
      if (fieldName === 'title') return issue.title;
      if (fieldName === 'state') return issue.state.toUpperCase();
      if (fieldName === 'body') return issue.body;
      if (fieldName === 'createdAt') return new Date(issue.createdAt * 1000).toISOString();
      if (fieldName === 'updatedAt') return new Date(issue.updatedAt * 1000).toISOString();
      if (fieldName === 'author') return { __typename: 'User', login: issue.user, id: 1000 };
      if (fieldName === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (fieldName === 'labels') return issue.labels;
      break;
    }
    case 'IssueConnection': {
      const page = parent as { __typename: string; all: Issue[]; first: number; after: number | null; repo: Repo };
      if (fieldName === 'nodes') {
        let list = page.all;
        if (page.after !== null) list = list.filter((i) => i.number < page.after!);
        return list.slice(0, page.first).map((i) => issueNode(page.repo, i));
      }
      if (fieldName === 'totalCount') return page.all.length;
      if (fieldName === 'pageInfo') {
        let list = page.all;
        if (page.after !== null) list = list.filter((i) => i.number < page.after!);
        const slice = list.slice(0, page.first);
        const hasNextPage = list.length > page.first;
        const endCursor = slice.length > 0 ? encodeCursor(slice[slice.length - 1].number) : null;
        return { __typename: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: page.after !== null, startCursor: slice.length > 0 ? encodeCursor(slice[0].number) : null };
      }
      break;
    }
    case 'PageInfo': {
      if (fieldName === 'hasNextPage') return parent.hasNextPage as boolean;
      if (fieldName === 'hasPreviousPage') return parent.hasPreviousPage as boolean;
      if (fieldName === 'startCursor') return parent.startCursor as string | null;
      if (fieldName === 'endCursor') return parent.endCursor as string | null;
      break;
    }
    case 'PullRequest': {
      const repo = parent.repo as Repo;
      const pull = parent.pull as Pull;
      if (fieldName === 'id') return globalId('PullRequest', repo.id, pull.number);
      if (fieldName === 'number') return pull.number;
      if (fieldName === 'title') return pull.title;
      if (fieldName === 'body') return pull.body;
      if (fieldName === 'state') return pull.state.toUpperCase();
      if (fieldName === 'merged') return pull.merged;
      if (fieldName === 'mergeable') return forge.mergeable(repo, pull);
      if (fieldName === 'headRefName') return pull.headRef;
      if (fieldName === 'baseRefName') return pull.baseRef;
      if (fieldName === 'headRef') return { __typename: 'Ref', name: pull.headRef };
      if (fieldName === 'baseRef') return { __typename: 'Ref', name: pull.baseRef };
      if (fieldName === 'createdAt') return new Date(pull.createdAt * 1000).toISOString();
      if (fieldName === 'updatedAt') return new Date(pull.updatedAt * 1000).toISOString();
      if (fieldName === 'author') return { __typename: 'User', login: repo.owner, id: 1000 };
      if (fieldName === 'mergeCommit') {
        if (!pull.mergeCommitSha) return null;
        const obj = repo.objects.get(pull.mergeCommitSha);
        if (!obj || obj.type !== 'commit') return null;
        return { __typename: 'Commit', oid: pull.mergeCommitSha };
      }
      if (fieldName === 'files') {
        const first = typeof args.first === 'number' ? args.first : 10;
        const files = pullFilesList(forge, repo, pull);
        return { __typename: 'PullRequestFileConnection', nodes: files.slice(0, first), totalCount: files.length };
      }
      break;
    }
    case 'PullRequestConnection': {
      if (fieldName === 'nodes') return parent.nodes as unknown[];
      if (fieldName === 'totalCount') return parent.totalCount as number;
      if (fieldName === 'pageInfo') {
        return { __typename: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null };
      }
      break;
    }
    case 'PullRequestFileConnection': {
      if (fieldName === 'nodes') return parent.nodes as unknown[];
      if (fieldName === 'totalCount') return parent.totalCount as number;
      break;
    }
    case 'PullRequestFile': {
      if (fieldName === 'path') return parent.path as string;
      if (fieldName === 'additions') return parent.additions as number;
      if (fieldName === 'deletions') return parent.deletions as number;
      if (fieldName === 'changeType') return parent.changeType as string;
      break;
    }
    case 'Mutation': {
      return resolveMutation(parent, fieldName, args, ctx);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (fieldName === 'issue') return parent.issue as NodeValue | null;
      if (fieldName === 'clientMutationId') return null;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (fieldName === 'pullRequest') return parent.pullRequest as NodeValue | null;
      if (fieldName === 'clientMutationId') return null;
      break;
    }
    case 'AddCommentPayload': {
      if (fieldName === 'commentEdge') return parent.commentEdge as NodeValue | null;
      if (fieldName === 'clientMutationId') return null;
      break;
    }
    case 'CommentEdge': {
      if (fieldName === 'node') return parent.node as NodeValue;
      if (fieldName === 'cursor') return parent.cursor as string;
      break;
    }
    case 'Comment': {
      if (fieldName === 'id') return parent.id as string;
      if (fieldName === 'body') return parent.body as string;
      if (fieldName === 'author') return { __typename: 'User', login: parent.author as string, id: 1000 };
      if (fieldName === 'createdAt') return parent.createdAt as string;
      if (fieldName === 'updatedAt') return parent.updatedAt as string;
      break;
    }
    case '__Type': {
      const typeName = parent.typeName as string;
      if (fieldName === 'name') return typeName;
      if (fieldName === 'kind') return typeName === 'SearchType' ? 'ENUM' : 'OBJECT';
      if (fieldName === 'fields') {
        const names = TYPE_FIELDS[typeName] ?? [];
        return names.map((n) => ({ __typename: '__Field', name: n }));
      }
      if (fieldName === 'enumValues') {
        if (typeName !== 'SearchType') return [];
        return SEARCH_TYPES.map((n) => ({ __typename: '__EnumValue', name: n }));
      }
      break;
    }
    case '__Field': {
      if (fieldName === 'name') return parent.name as string;
      if (fieldName === 'type') return { __typename: '__Type', typeName: 'String' };
      if (fieldName === 'args') return [];
      break;
    }
    case '__EnumValue': {
      if (fieldName === 'name') return parent.name as string;
      break;
    }
  }
  return undefined;
}

/** The issues connection for a repository, honouring states / orderBy / first / after. */
function issuesConnection(repo: Repo, args: Record<string, unknown>): NodeValue {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const direction = orderBy && String(orderBy.direction ?? 'DESC').toUpperCase() === 'ASC' ? 'asc' : 'desc';
  list.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return direction === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
    return direction === 'asc' ? a.number - b.number : b.number - a.number;
  });
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = typeof args.after === 'string' && args.after ? decodeCursor(args.after) : null;
  return { __typename: 'IssueConnection', all: list, first, after, repo };
}

/** Changed files of a pull request, as GraphQL file nodes. */
function pullFilesList(forge: Forge, repo: Repo, pull: Pull): NodeValue[] {
  // Reuse the REST file diff by walking the two trees.
  const baseSha = forge.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
  const headSha = forge.resolveRef(repo, pull.headRef) ?? pull.headSha;
  const baseTree = baseSha && baseSha !== '0000000000000000000000000000000000000000' ? (forge.commitOf(repo, baseSha)?.tree ?? '0000000000000000000000000000000000000000') : '0000000000000000000000000000000000000000';
  const headTree = headSha && headSha !== '0000000000000000000000000000000000000000' ? (forge.commitOf(repo, headSha)?.tree ?? '0000000000000000000000000000000000000000') : '0000000000000000000000000000000000000000';
  const baseFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  const walk = (treeOid: string, prefix: string, into: Map<string, string>): void => {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') walk(e.oid, prefix + e.name + '/', into);
      else into.set(prefix + e.name, e.oid);
    }
  };
  walk(baseTree, '', baseFiles);
  walk(headTree, '', headFiles);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: NodeValue[] = [];
  for (const path of [...paths].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b === h) continue;
    const changeType = b === undefined ? 'ADDED' : h === undefined ? 'REMOVED' : 'MODIFIED';
    out.push({ __typename: 'PullRequestFile', path, additions: 0, deletions: 0, changeType });
  }
  return out;
}


// -------------------------------------------------------------------------------------------
// Mutations
// -------------------------------------------------------------------------------------------

function resolveMutation(
  _parent: NodeValue,
  fieldName: string,
  args: Record<string, unknown>,
  ctx: ExecContext,
): unknown {
  const forge = ctx.forge;
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (fieldName === 'createIssue') {
    const repo = repoByGlobalId(forge, String(input.repositoryId ?? ''));
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return { __typename: 'CreateIssuePayload', issue: null };
    }
    const issue = forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) };
  }
  if (fieldName === 'closeIssue') {
    const found = issueByGlobalId(forge, String(input.issueId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return { __typename: 'CloseIssuePayload', issue: null };
    }
    found.issue.state = 'closed';
    found.issue.updatedAt = forge.nextTimestamp();
    return { __typename: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue) };
  }
  if (fieldName === 'createPullRequest') {
    const repo = repoByGlobalId(forge, String(input.repositoryId ?? ''));
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return { __typename: 'CreatePullRequestPayload', pullRequest: null };
    }
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? forge.viewer().login);
    if (!forge.resolveRef(repo, headRef) || !forge.resolveRef(repo, baseRef)) {
      ctx.errors.push({ message: 'head or base branch does not exist.' });
      return { __typename: 'CreatePullRequestPayload', pullRequest: null };
    }
    const pull = forge.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), headRef, baseRef);
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
  }
  if (fieldName === 'mergePullRequest') {
    const found = pullByGlobalId(forge, String(input.pullRequestId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
      return { __typename: 'MergePullRequestPayload', pullRequest: null };
    }
    const mergedSha = forge.mergePull(found.repo, found.pull);
    if (!mergedSha) {
      ctx.errors.push({ message: 'Merge conflict.' });
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull) };
    }
    return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull) };
  }
  if (fieldName === 'addComment') {
    const found = issueByGlobalId(forge, String(input.subjectId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return { __typename: 'AddCommentPayload', commentEdge: null };
    }
    const commentId = found.repo.nextCommentId++;
    const comment = {
      id: commentId,
      body: String(input.body ?? ''),
      createdAt: forge.nextTimestamp(),
      user: forge.viewer().login,
    };
    const list = found.repo.comments.get(found.issue.number) ?? [];
    list.push(comment);
    found.repo.comments.set(found.issue.number, list);
    const node: NodeValue = {
      __typename: 'Comment',
      id: globalId('IssueComment', found.repo.id, found.issue.number, commentId),
      body: comment.body,
      author: comment.user,
      createdAt: new Date(comment.createdAt * 1000).toISOString(),
      updatedAt: new Date(comment.createdAt * 1000).toISOString(),
    };
    return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node, cursor: encodeCursor(commentId) } };
  }
  return undefined;
}

// -------------------------------------------------------------------------------------------
// HTTP handler
// -------------------------------------------------------------------------------------------

interface GraphqlRequestBody {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function executeDocument(
  forge: Forge,
  body: GraphqlRequestBody,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (body.variables ?? {}) as Record<string, unknown>;
  const ctx: ExecContext = { forge, variables, errors: [] };
  let operations: OperationNode[];
  try {
    operations = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation in document' }] };
  }
  const op = operations[0];
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: NodeValue = { __typename: rootType };
  const data = executeSelection(root, op.selection, ctx);
  const result: { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

export async function handleGraphql(req: Req, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, req, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (!isAuthenticated(req)) {
    sendJson(res, req, 401, { message: 'Requires authentication' });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    sendJson(res, req, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(body)) {
    // Batched operations: answer one result per document, in order.
    const results = body.map((item) =>
      executeDocument(req.forge, (item ?? {}) as GraphqlRequestBody),
    );
    sendJson(res, req, 200, results);
    return;
  }
  const result = executeDocument(req.forge, (body ?? {}) as GraphqlRequestBody);
  sendJson(res, req, 200, result);
}
