// app.ts — HTTP server, routing, auth, response helpers. Node 22 stdlib only.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

export interface Req {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Buffer;
  forge: Forge;
  requestId: string;
}

export function bearerToken(req: Req): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/.exec(auth);
  return m ? m[1].trim() : null;
}

/** True when the request carries the trial token. */
export function isAuthenticated(req: Req): boolean {
  const token = bearerToken(req);
  if (!token) return false;
  if (!req.forge.token) return true; // No token configured: any bearer token counts.
  return token === req.forge.token;
}

export function sendJson(
  res: ServerResponse,
  req: Req,
  status: number,
  obj: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': req.requestId,
    'content-length': String(body.length),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

export function sendBytes(
  res: ServerResponse,
  req: Req,
  status: number,
  body: Buffer,
  contentType: string,
  extraHeaders?: Record<string, string>,
): void {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'x-github-request-id': req.requestId,
    'content-length': String(body.length),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

/** Read the request body (up to 64 MiB). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/;

export function createApp(forge: Forge) {
  const server = createServer(async (incoming: IncomingMessage, res: ServerResponse) => {
    const requestId = forge.nextRequestId();
    try {
      const body = await readBody(incoming);
      const url = new URL(incoming.url ?? '/', 'http://localhost');
      const req: Req = {
        method: (incoming.method ?? 'GET').toUpperCase(),
        pathname: url.pathname,
        query: url.searchParams,
        headers: incoming.headers,
        body,
        forge,
        requestId,
      };
      // Health check (no auth, no JSON envelope rules beyond a JSON body).
      if (req.pathname === '/healthz' && req.method === 'GET') {
        sendJson(res, req, 200, { ok: true });
        return;
      }
      // Git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = GIT_PATH.exec(req.pathname);
      if (gitMatch) {
        const handled = await handleGit(req, res, gitMatch[1], gitMatch[2], gitMatch[3]);
        if (handled) return;
      }
      // GraphQL: /api/graphql (checked before /api/v3 since it is not under it).
      if (req.pathname === '/api/graphql') {
        await handleGraphql(req, res);
        return;
      }
      // MCP: /mcp.
      if (req.pathname === '/mcp') {
        await handleMcp(req, res);
        return;
      }
      // REST v3: /api/v3/...
      if (req.pathname === '/api/v3' || req.pathname.startsWith('/api/v3/')) {
        await handleRest(req, res);
        return;
      }
      // Anything else: JSON 404.
      sendJson(res, req, 404, { message: 'Not Found' });
    } catch (err) {
      if (!res.headersSent) {
        const requestIdHeader = requestId;
        res.writeHead(500, {
          'content-type': 'application/json',
          'x-github-request-id': requestIdHeader,
        });
        res.end(JSON.stringify({ message: `Internal Server Error: ${err instanceof Error ? err.message : String(err)}` }));
      } else {
        res.end();
      }
    }
  });
  return server;
}
