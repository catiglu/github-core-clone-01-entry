// Entry point: the lifecycle handshake between this process and the trial env.
//
// The env (see env/src/wire.ts in the harness) expects exactly this dance:
//   1. Bind an ephemeral TCP port with listen(0). Port 8080 belongs to the env — never take it.
//   2. POST the bound port to $MAKEFUN_ENV_URL/register. The env combines the request's source
//      address with that port into our base URL and dials us from then on. The first register
//      wins; 409 only means another entry got there first, which is not ours to fix — we keep
//      serving either way.
//   3. Poll $MAKEFUN_ENV_URL/done until the body is {"done":true}. The env answers immediately
//      ({"done":false} while the suite runs), so this is a cheap poll, not a held request. A
//      failed or slow poll is retried with a short exponential backoff; we never exit before the
//      env says done.
//   4. Close the server and exit 0. The harness then stops the env, which writes the export the
//      scorer reads.
//
// Without MAKEFUN_ENV_URL there is nothing to talk to, so we give up at once with exit 1.
// Everything the suite scores lives in app.ts; this file only performs the handshake.

import { createApp } from './app.ts';

/** Time budget for a single register/done request before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Retry backoff: starts at FLOOR, doubles per miss, never exceeds MAX. */
const BACKOFF_FLOOR_MS = 250;
const BACKOFF_MAX_MS = 2_000;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to pause after `misses` consecutive failed requests. */
function backoffAfter(misses: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FLOOR_MS * 2 ** Math.min(misses, 8));
}

/** Read the env origin from the environment, or exit at once when it is absent. */
function envOrigin(): string {
  const origin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (origin === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }
  return origin;
}

/**
 * Tell the env which port we bound, retrying until it accepts. 200 is the normal answer and 409
 * means a first register already won. 400 and 405 are contract errors that end the program; a
 * network error or any other status is retried, since the env may still be starting up.
 */
async function registerPort(env: string, port: number): Promise<void> {
  for (let miss = 0; ; miss += 1) {
    try {
      const res = await fetch(`${env}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register rejected with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register rejected with HTTP ')) throw err;
    }
    await wait(backoffAfter(miss));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function pollUntilDone(env: string): Promise<void> {
  for (let miss = 0; ; miss += 1) {
    try {
      const res = await fetch(`${env}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await wait(backoffAfter(miss));
  }
}

/** Bind an ephemeral port, register it with the env, then wait for the trial to end. */
async function run(): Promise<void> {
  const env = envOrigin();

  const server = createApp();
  const listening = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve());
  });
  server.listen(0);
  await listening;

  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] server listening on port ${addr.port}\n`);

  await registerPort(env, addr.port);
  process.stdout.write('[entry] registered; waiting for the env to finish the trial\n');

  await pollUntilDone(env);
  server.close();
  process.stdout.write('[entry] done; closing the server and exiting\n');
}

run().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
