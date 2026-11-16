// main.ts — forge entrypoint. One process: serve the forge on an ephemeral port,
// register that port with the suite env, and stay up until the env says done.
// Node 22+ strips the types; the only imports are the app and the store.
import { Forge } from './store.ts';
import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL;
if (!ENV_URL) {
  console.error('MAKEFUN_ENV_URL is not set; the suite has nowhere to dial.');
  process.exit(1);
}
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const BASE = ENV_URL.replace(/\/$/, '');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function register(port: number): Promise<void> {
  const started = Date.now();
  let wait = 250;
  for (;;) {
    const response = await fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    }).catch(() => null);
    if (response && response.status === 200) return;
    if (response && (response.status === 400 || response.status === 405)) {
      throw new Error(`register refused with HTTP ${response.status}`);
    }
    if (Date.now() - started > 30_000) {
      throw new Error('register timed out after 30s');
    }
    await sleep(wait);
    wait = Math.min(wait * 2, 2000);
  }
}

async function waitUntilDone(): Promise<void> {
  for (;;) {
    const response = await fetch(`${BASE}/done`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (response && response.ok) {
      const body = (await response.json().catch(() => null)) as { done?: boolean } | null;
      if (body && body.done === true) return;
    }
    await sleep(250);
  }
}

async function main(): Promise<void> {
  const forge = new Forge(SHOP_TOKEN);
  const server = createApp(forge);
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('server did not bind a port'));
        return;
      }
      resolve(address.port);
    });
  });
  console.log(`forge listening on port ${port}`);
  await register(port);
  console.log('registered with the suite; waiting for done');
  await waitUntilDone();
  server.close();
  console.log('suite done; exiting 0');
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
