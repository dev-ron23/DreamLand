/**
 * Rate limiter middleware for the Discord OAuth2 join flow.
 *
 * Exports two named rate limiters:
 *   - `joinRateLimiter`:     10 requests per 15-minute window per IP
 *   - `callbackRateLimiter`: 20 requests per 15-minute window per IP
 *
 * Both respond with HTTP 429 and a `Retry-After` header when the limit is
 * exceeded (via `standardHeaders: true`).
 *
 * When `REDIS_URL` is set, the middleware attempts to use `rate-limit-redis`
 * backed by the `redis` npm package so that rate-limit state is shared across
 * all backend instances (Requirement 16.2). If the `redis` package is not
 * installed, it falls back to the default in-memory store with a warning.
 *
 * NOTE: `process.env.REDIS_URL` is read directly here — we intentionally do
 * NOT import from `src/config.ts` to avoid requiring all env vars to be
 * present at module load time (e.g. during tests).
 *
 * Requirements: 2.4, 2.5, 3.7, 3.8, 13.1, 13.2, 13.3, 13.4, 16.2
 */

import rateLimit, { Store } from 'express-rate-limit';

// ---------------------------------------------------------------------------
// Redis store setup (optional)
// ---------------------------------------------------------------------------

/**
 * Attempts to build a `RedisStore` instance backed by the `redis` package.
 * Returns `undefined` if `REDIS_URL` is not set or if the `redis` package is
 * not available, allowing the caller to fall back to the in-memory store.
 */
function buildRedisStore(prefix: string): Store | undefined {
  const redisUrl = process.env['REDIS_URL'];
  if (!redisUrl) {
    return undefined;
  }

  try {
    // Dynamically require both packages so that missing packages cause a
    // graceful fallback rather than a hard crash at module load time.
    // We use `any` casts here because the `redis` package may not be installed
    // (it is an optional peer dependency), so TypeScript cannot resolve its types.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const { createClient } = require('redis') as any;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RedisStore } = require('rate-limit-redis') as typeof import('rate-limit-redis');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = createClient({ url: redisUrl });

    // Connect asynchronously — rate-limit-redis only needs `sendCommand` to
    // be callable; the client will queue commands until connected.
    client.connect().catch((err: unknown) => {
      console.error('[rateLimiter] Redis connection error:', err);
    });

    return new RedisStore({
      sendCommand: (...args: string[]) => client.sendCommand(args) as Promise<import('rate-limit-redis').RedisReply>,
      prefix,
    });
  } catch (err) {
    console.warn(
      '[rateLimiter] REDIS_URL is set but the "redis" package is not available. ' +
        'Falling back to in-memory rate limit store. ' +
        'Install the "redis" package to enable shared rate limiting across instances.',
      err,
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Shared window duration
// ---------------------------------------------------------------------------

/** 15 minutes in milliseconds */
const WINDOW_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// joinRateLimiter — 10 requests / 15 min per IP (Requirement 13.1)
// ---------------------------------------------------------------------------

export const joinRateLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 10,
  standardHeaders: true,  // Emit `RateLimit-*` headers (includes Retry-After)
  legacyHeaders: false,   // Disable deprecated `X-RateLimit-*` headers
  store: buildRedisStore('rl:join:'),
});

// ---------------------------------------------------------------------------
// callbackRateLimiter — 20 requests / 15 min per IP (Requirement 13.2)
// ---------------------------------------------------------------------------

export const callbackRateLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildRedisStore('rl:callback:'),
});
