/**
 * Integration tests for the Discord OAuth2 Join Flow.
 *
 * Tests the full HTTP request/response cycle using Supertest against the
 * Express app. Discord API calls are mocked with jest.spyOn(global, 'fetch').
 *
 * The config module is mocked BEFORE importing the app so that config is
 * loaded with test values rather than requiring real environment variables.
 *
 * Tasks: 14.1 – 14.8
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.6,
 *               4.1, 5.1, 6.1, 6.3, 7.1, 7.2, 10.5, 10.6, 13.1, 13.3
 */

// ---------------------------------------------------------------------------
// Mock config BEFORE importing app (app imports config at load time)
// ---------------------------------------------------------------------------

jest.mock('../config', () => ({
  config: {
    DISCORD_CLIENT_ID: 'test-client-id',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    DISCORD_REDIRECT_URI: 'https://example.com/auth/discord/callback',
    DISCORD_GUILD_ID: 'test-guild-id',
    DISCORD_BOT_TOKEN: 'Bot test-bot-token',
    COOKIE_SECRET: 'test-cookie-secret-at-least-32-chars!!',
    IP_HASH_SALT: 'test-ip-salt',
    UA_HASH_SALT: 'test-ua-salt',
    PORT: 3000,
    NODE_ENV: 'test',
    DATABASE_URL: undefined,
    CUSTOM_DM_ENABLED: false,
    CUSTOM_WELCOME_MESSAGE: 'Welcome!',
    REDIRECT_ALLOWLIST: ['/success'],
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mock setup)
// ---------------------------------------------------------------------------

import request from 'supertest';
import cookieSignature from 'cookie-signature';
import app from '../app';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars!!';

/**
 * Build a signed `oauth_state` cookie value that cookie-parser will accept.
 *
 * cookie-parser stores signed cookies as:
 *   s:<raw-value>.<hmac-signature>
 *
 * The raw value is the JSON-serialised OAuthState object.
 */
function buildSignedStateCookie(token: string, createdAt: number): string {
  const raw = JSON.stringify({ token, createdAt });
  return 's:' + cookieSignature.sign(raw, COOKIE_SECRET);
}

/**
 * Parse the Set-Cookie header array and return the value of the named cookie,
 * or undefined if not present.
 */
function findSetCookieHeader(
  headers: string | string[] | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const list = Array.isArray(headers) ? headers : [headers];
  return list.find((h) => h.startsWith(`${name}=`));
}

// ---------------------------------------------------------------------------
// Shared mock responses
// ---------------------------------------------------------------------------

const MOCK_TOKEN_RESPONSE = {
  access_token: 'mock-access-token',
  token_type: 'Bearer' as const,
  expires_in: 604800,
  refresh_token: 'mock-refresh-token',
  scope: 'identify guilds.join',
};

const MOCK_DISCORD_USER = {
  id: '123456789012345678',
  username: 'testuser',
  discriminator: '0',
  avatar: null,
};

/**
 * Create a mock fetch implementation that handles the three Discord API calls
 * made during a successful callback:
 *   1. POST /oauth2/token        → 200 with token response
 *   2. GET  /users/@me           → 200 with user object
 *   3. PUT  /guilds/.../members/... → statusCode with optional body
 */
function mockDiscordFetch(guildMemberStatus: 201 | 204): jest.Mock {
  return jest.fn().mockImplementation((url: string, options?: RequestInit) => {
    const urlStr = String(url);

    // Token exchange
    if (urlStr.includes('/oauth2/token')) {
      return Promise.resolve(
        new Response(JSON.stringify(MOCK_TOKEN_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }

    // User identity fetch
    if (urlStr.includes('/users/@me') && options?.method !== 'POST') {
      return Promise.resolve(
        new Response(JSON.stringify(MOCK_DISCORD_USER), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }

    // Guild member addition
    if (urlStr.includes('/guilds/') && urlStr.includes('/members/')) {
      return Promise.resolve(
        new Response(null, { status: guildMemberStatus }),
      );
    }

    // Fallback — should not be reached in these tests
    return Promise.resolve(new Response(null, { status: 500 }));
  });
}

// ---------------------------------------------------------------------------
// 14.1 — GET /auth/discord sets signed cookie and redirects to Discord
// Requirements: 2.1, 2.2, 2.3
// ---------------------------------------------------------------------------

describe('14.1 GET /auth/discord — initiate OAuth2 flow', () => {
  it('returns HTTP 302 and redirects to Discord authorization URL', async () => {
    const res = await request(app).get('/auth/discord');

    expect(res.status).toBe(302);
    expect(res.headers['location']).toMatch(
      /^https:\/\/discord\.com\/oauth2\/authorize/,
    );
  });

  it('includes required OAuth2 query parameters in the redirect URL', async () => {
    const res = await request(app).get('/auth/discord');

    const location = res.headers['location'] as string;
    const url = new URL(location);

    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('identify guilds.join');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://example.com/auth/discord/callback',
    );
    // state must be a 64-char hex string
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sets the oauth_state signed cookie with correct attributes', async () => {
    const res = await request(app).get('/auth/discord');

    const setCookieHeader = findSetCookieHeader(
      res.headers['set-cookie'] as string | string[],
      'oauth_state',
    );

    expect(setCookieHeader).toBeDefined();
    // Signed cookies start with "s%3A" (URL-encoded "s:")
    expect(setCookieHeader).toMatch(/oauth_state=s%3A/);
    // httpOnly attribute
    expect(setCookieHeader?.toLowerCase()).toContain('httponly');
    // secure attribute
    expect(setCookieHeader?.toLowerCase()).toContain('secure');
    // samesite=lax
    expect(setCookieHeader?.toLowerCase()).toContain('samesite=lax');
    // max-age present (10 minutes = 600 seconds)
    expect(setCookieHeader?.toLowerCase()).toContain('max-age=600');
  });
});

// ---------------------------------------------------------------------------
// 14.2 — Valid callback redirects to /success
// Requirements: 3.1, 3.4, 4.1, 5.1, 6.1, 7.1
// ---------------------------------------------------------------------------

describe('14.2 GET /auth/discord/callback — valid flow redirects to /success', () => {
  it('redirects to /success when state matches and Discord APIs succeed (201)', async () => {
    // Step 1: Get a real signed cookie from the initiation endpoint
    const initRes = await request(app).get('/auth/discord');
    const setCookieHeader = findSetCookieHeader(
      initRes.headers['set-cookie'] as string | string[],
      'oauth_state',
    );
    expect(setCookieHeader).toBeDefined();

    // Extract the cookie value (everything before the first ';')
    const cookieValue = setCookieHeader!.split(';')[0]!; // "oauth_state=s%3A..."

    // Extract the state token from the redirect URL
    const location = initRes.headers['location'] as string;
    const stateToken = new URL(location).searchParams.get('state')!;

    // Step 2: Mock fetch for Discord API calls
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      mockDiscordFetch(201),
    );

    // Step 3: Call the callback with the real cookie and matching state
    const callbackRes = await request(app)
      .get(`/auth/discord/callback?code=test-code&state=${stateToken}`)
      .set('Cookie', cookieValue);

    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers['location']).toBe('/success');

    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 14.3 — Mismatched state redirects to /error?reason=invalid_state
// Requirements: 3.1, 3.2, 10.6
// ---------------------------------------------------------------------------

describe('14.3 GET /auth/discord/callback — mismatched state', () => {
  it('redirects to /error?reason=invalid_state when state does not match cookie', async () => {
    // Build a valid signed cookie with a known token
    const token = 'a'.repeat(64);
    const signedCookie = buildSignedStateCookie(token, Date.now());

    // Send a callback with a DIFFERENT state value
    const wrongState = 'b'.repeat(64);

    const res = await request(app)
      .get(`/auth/discord/callback?code=test-code&state=${wrongState}`)
      .set('Cookie', `oauth_state=${encodeURIComponent(signedCookie)}`);

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/error?reason=invalid_state');
  });

  it('redirects to /error?reason=invalid_state when oauth_state cookie is absent', async () => {
    const res = await request(app).get(
      '/auth/discord/callback?code=test-code&state=somestate',
    );

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/error?reason=invalid_state');
  });
});

// ---------------------------------------------------------------------------
// 14.4 — Expired state cookie redirects to /error?reason=state_expired
// Requirements: 3.3
// ---------------------------------------------------------------------------

describe('14.4 GET /auth/discord/callback — expired state cookie', () => {
  it('redirects to /error?reason=state_expired when createdAt is > 10 minutes ago', async () => {
    const token = 'c'.repeat(64);
    // Set createdAt to 11 minutes in the past
    const expiredCreatedAt = Date.now() - 11 * 60 * 1000;
    const signedCookie = buildSignedStateCookie(token, expiredCreatedAt);

    const res = await request(app)
      .get(`/auth/discord/callback?code=test-code&state=${token}`)
      .set('Cookie', `oauth_state=${encodeURIComponent(signedCookie)}`);

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/error?reason=state_expired');
  });
});

// ---------------------------------------------------------------------------
// 14.5 — Discord 204 redirects to /success?already_member=true
// Requirements: 6.3, 7.2
// ---------------------------------------------------------------------------

describe('14.5 GET /auth/discord/callback — already member (Discord 204)', () => {
  it('redirects to /success?already_member=true when guild member PUT returns 204', async () => {
    // Step 1: Get a real signed cookie from the initiation endpoint
    const initRes = await request(app).get('/auth/discord');
    const setCookieHeader = findSetCookieHeader(
      initRes.headers['set-cookie'] as string | string[],
      'oauth_state',
    );
    const cookieValue = setCookieHeader!.split(';')[0]!;
    const stateToken = new URL(initRes.headers['location'] as string).searchParams.get('state')!;

    // Step 2: Mock fetch — guild member PUT returns 204
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      mockDiscordFetch(204),
    );

    const callbackRes = await request(app)
      .get(`/auth/discord/callback?code=test-code&state=${stateToken}`)
      .set('Cookie', cookieValue);

    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers['location']).toBe('/success?already_member=true');

    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 14.6 — Rate limiter returns 429 after limit exceeded
// Requirements: 2.4, 2.5, 13.1, 13.3
// ---------------------------------------------------------------------------

describe('14.6 GET /auth/discord — rate limiter', () => {
  it('returns 429 with Retry-After header after 10 requests from the same IP', async () => {
    // The joinRateLimiter allows 10 requests per 15-minute window.
    // We need a fresh app instance so the in-memory counter starts at 0.
    // Re-require the app module to get a fresh rate limiter state.

    // Reset modules to get a fresh rate limiter
    jest.resetModules();

    // Re-mock config after resetModules
    jest.mock('../config', () => ({
      config: {
        DISCORD_CLIENT_ID: 'test-client-id',
        DISCORD_CLIENT_SECRET: 'test-client-secret',
        DISCORD_REDIRECT_URI: 'https://example.com/auth/discord/callback',
        DISCORD_GUILD_ID: 'test-guild-id',
        DISCORD_BOT_TOKEN: 'Bot test-bot-token',
        COOKIE_SECRET: 'test-cookie-secret-at-least-32-chars!!',
        IP_HASH_SALT: 'test-ip-salt',
        UA_HASH_SALT: 'test-ua-salt',
        PORT: 3000,
        NODE_ENV: 'test',
        DATABASE_URL: undefined,
        CUSTOM_DM_ENABLED: false,
        CUSTOM_WELCOME_MESSAGE: 'Welcome!',
        REDIRECT_ALLOWLIST: ['/success'],
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const freshApp = (await import('../app')).default;

    // Send 10 requests — all should succeed (302)
    for (let i = 0; i < 10; i++) {
      const res = await request(freshApp).get('/auth/discord');
      expect(res.status).toBe(302);
    }

    // The 11th request should be rate-limited
    const limitedRes = await request(freshApp).get('/auth/discord');
    expect(limitedRes.status).toBe(429);
    // Retry-After header must be present (express-rate-limit uses RateLimit-Reset
    // with standardHeaders:true; the actual header name may vary by version)
    const hasRetryAfter =
      limitedRes.headers['retry-after'] !== undefined ||
      limitedRes.headers['ratelimit-reset'] !== undefined ||
      limitedRes.headers['x-ratelimit-reset'] !== undefined;
    expect(hasRetryAfter).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 14.7 — access_denied error param redirects to /error?reason=access_denied
// Requirements: 3.6
// ---------------------------------------------------------------------------

describe('14.7 GET /auth/discord/callback — access_denied', () => {
  it('redirects to /error?reason=access_denied when Discord returns error=access_denied', async () => {
    const res = await request(app).get(
      '/auth/discord/callback?error=access_denied',
    );

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/error?reason=access_denied');
  });
});

// ---------------------------------------------------------------------------
// 14.8 — State cookie is cleared on callback regardless of outcome
// Property 3: One-Time State
// Validates: Requirements 3.4, 10.5
// ---------------------------------------------------------------------------

describe('14.8 GET /auth/discord/callback — oauth_state cookie cleared (Property 3: One-Time State)', () => {
  /**
   * **Validates: Requirements 3.4, 10.5**
   *
   * Property 3: One-Time State
   *
   * The oauth_state cookie must be cleared on the first callback attempt,
   * regardless of whether validation succeeds or fails.
   */

  /**
   * Returns true if the Set-Cookie headers include a directive that clears
   * the oauth_state cookie (Max-Age=0 or Expires in the past).
   */
  function isCookieCleared(headers: Record<string, string | string[]>): boolean {
    const setCookie = headers['set-cookie'];
    if (!setCookie) return false;
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    return list.some(
      (h) =>
        h.startsWith('oauth_state=') &&
        (h.toLowerCase().includes('expires=thu, 01 jan 1970') ||
          h.toLowerCase().includes('max-age=0')),
    );
  }

  it('clears the oauth_state cookie on a SUCCESSFUL callback', async () => {
    // Get a real signed cookie
    const initRes = await request(app).get('/auth/discord');
    const setCookieHeader = findSetCookieHeader(
      initRes.headers['set-cookie'] as string | string[],
      'oauth_state',
    );
    const cookieValue = setCookieHeader!.split(';')[0]!;
    const stateToken = new URL(initRes.headers['location'] as string).searchParams.get('state')!;

    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      mockDiscordFetch(201),
    );

    const callbackRes = await request(app)
      .get(`/auth/discord/callback?code=test-code&state=${stateToken}`)
      .set('Cookie', cookieValue);

    expect(callbackRes.status).toBe(302);
    expect(isCookieCleared(callbackRes.headers as Record<string, string | string[]>)).toBe(true);

    fetchSpy.mockRestore();
  });

  it('clears the oauth_state cookie on a FAILED callback (mismatched state)', async () => {
    const token = 'd'.repeat(64);
    const signedCookie = buildSignedStateCookie(token, Date.now());
    const wrongState = 'e'.repeat(64);

    const callbackRes = await request(app)
      .get(`/auth/discord/callback?code=test-code&state=${wrongState}`)
      .set('Cookie', `oauth_state=${encodeURIComponent(signedCookie)}`);

    expect(callbackRes.status).toBe(302);
    expect(isCookieCleared(callbackRes.headers as Record<string, string | string[]>)).toBe(true);
  });

  it('clears the oauth_state cookie on a FAILED callback (expired state)', async () => {
    const token = 'f'.repeat(64);
    const expiredCreatedAt = Date.now() - 11 * 60 * 1000;
    const signedCookie = buildSignedStateCookie(token, expiredCreatedAt);

    const callbackRes = await request(app)
      .get(`/auth/discord/callback?code=test-code&state=${token}`)
      .set('Cookie', `oauth_state=${encodeURIComponent(signedCookie)}`);

    expect(callbackRes.status).toBe(302);
    expect(isCookieCleared(callbackRes.headers as Record<string, string | string[]>)).toBe(true);
  });
});
