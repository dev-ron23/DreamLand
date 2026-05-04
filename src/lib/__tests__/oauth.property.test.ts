/**
 * Property-based tests for OAuth utility functions.
 *
 * Uses fast-check to verify universal correctness invariants across arbitrary
 * inputs. The config module is mocked so tests do not require real env vars.
 */

import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// Mock the config module so tests run without real environment variables
// ---------------------------------------------------------------------------

jest.mock('../../config', () => ({
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

import {
  generateStateToken,
  buildAuthorizationUrl,
  hashForAnalytics,
  sanitizeRedirectUrl,
} from '../oauth';

// ---------------------------------------------------------------------------
// Property 3: generateStateToken always produces 64-char hex
// Validates: Requirements 2.1, 10.2
// ---------------------------------------------------------------------------

describe('generateStateToken', () => {
  /**
   * **Validates: Requirements 2.1, 10.2**
   *
   * Property 3: generateStateToken always produces 64-char hex
   *
   * No matter how many times it is called, the function must return a string
   * that is exactly 64 characters long and consists only of lowercase
   * hexadecimal digits (0-9, a-f).
   */
  it('Property 3: always produces a 64-character lowercase hex string', () => {
    fc.assert(
      fc.property(
        // We use an integer to drive the number of calls, but the function
        // itself takes no arguments — we just call it once per run.
        fc.integer({ min: 0, max: 0 }),
        (_unused) => {
          const token = generateStateToken();

          // Must be exactly 64 characters
          expect(token).toHaveLength(64);

          // Must consist only of lowercase hex digits
          expect(token).toMatch(/^[0-9a-f]{64}$/);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 3 (uniqueness): consecutive calls produce distinct tokens', () => {
    // Run 50 times and collect results — collisions should be astronomically
    // unlikely (probability < 50 * 1/2^256).
    const tokens = new Set(Array.from({ length: 50 }, () => generateStateToken()));
    expect(tokens.size).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Property 5: buildAuthorizationUrl always contains required params
// Validates: Requirements 2.3
// ---------------------------------------------------------------------------

describe('buildAuthorizationUrl', () => {
  /**
   * **Validates: Requirements 2.3**
   *
   * Property 5: buildAuthorizationUrl always contains required params
   *
   * For any valid state token, the returned URL must:
   *   - Start with the Discord authorization base URL
   *   - Contain response_type=code
   *   - Contain scope=identify+guilds.join (URL-encoded space)
   *   - Contain the exact state token passed in
   *   - Contain prompt=consent
   *   - Contain the configured client_id and redirect_uri
   */
  it('Property 5: always contains all required OAuth2 parameters', () => {
    // Arbitrary 64-char hex strings as state tokens
    const hexChar = fc.constantFrom(...'0123456789abcdef'.split(''));
    const stateTokenArb = fc.array(hexChar, { minLength: 64, maxLength: 64 }).map((chars) =>
      chars.join(''),
    );

    fc.assert(
      fc.property(stateTokenArb, (stateToken) => {
        const url = buildAuthorizationUrl(stateToken);
        const parsed = new URL(url);
        const params = parsed.searchParams;

        // Base URL
        expect(url).toMatch(/^https:\/\/discord\.com\/oauth2\/authorize/);

        // Required parameters
        expect(params.get('response_type')).toBe('code');
        expect(params.get('scope')).toBe('identify guilds.join');
        expect(params.get('state')).toBe(stateToken);
        expect(params.get('prompt')).toBe('consent');
        expect(params.get('client_id')).toBe('test-client-id');
        expect(params.get('redirect_uri')).toBe(
          'https://example.com/auth/discord/callback',
        );
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11: Deterministic Hashing
// Validates: Requirements 14.1, 14.2, 14.3, 14.4
// ---------------------------------------------------------------------------

describe('hashForAnalytics', () => {
  /**
   * **Validates: Requirements 14.1, 14.2, 14.3, 14.4**
   *
   * Property 11: Deterministic Hashing — same inputs always produce the same
   * 64-char hex output.
   *
   * For any (value, salt) pair:
   *   1. The output is always exactly 64 characters.
   *   2. The output consists only of lowercase hex digits.
   *   3. Calling the function twice with the same inputs yields the same result.
   *   4. Changing either input changes the output (collision resistance).
   */
  it('Property 11: same inputs always produce the same 64-char hex output', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (value, salt) => {
          const hash1 = hashForAnalytics(value, salt);
          const hash2 = hashForAnalytics(value, salt);

          // Deterministic: same inputs → same output
          expect(hash1).toBe(hash2);

          // Output is exactly 64 characters
          expect(hash1).toHaveLength(64);

          // Output is lowercase hex
          expect(hash1).toMatch(/^[0-9a-f]{64}$/);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('Property 11 (sensitivity): different inputs produce different outputs', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (value, salt1, salt2) => {
          // Different salts should (almost certainly) produce different hashes
          fc.pre(salt1 !== salt2);
          const hash1 = hashForAnalytics(value, salt1);
          const hash2 = hashForAnalytics(value, salt2);
          expect(hash1).not.toBe(hash2);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5 (sanitizeRedirectUrl): Open Redirect Prevention
// Validates: Requirements 12.1, 12.2, 12.3, 12.4
// ---------------------------------------------------------------------------

describe('sanitizeRedirectUrl', () => {
  /**
   * **Validates: Requirements 12.1, 12.2, 12.3, 12.4**
   *
   * Property 5: Open Redirect Prevention — always returns a URL in the
   * allowlist.
   *
   * For any (url, allowlist) combination, the returned value must start with
   * one of the allowlist prefixes. This guarantees the function can never be
   * used as an open redirect vector.
   */
  it('Property 5: always returns a URL that starts with an allowlist prefix', () => {
    // Generate a non-empty allowlist of URL prefixes
    const prefixArb = fc.oneof(
      fc.constant('/success'),
      fc.constant('/dashboard'),
      fc.constant('https://example.com/'),
      fc.webUrl(),
    );
    const allowlistArb = fc
      .array(prefixArb, { minLength: 1, maxLength: 5 })
      .map((arr) => [...new Set(arr)]) // deduplicate
      .filter((arr) => arr.length > 0);

    // Arbitrary candidate URLs (including potentially malicious ones)
    const urlArb = fc.oneof(
      fc.constant(undefined),
      fc.constant(''),
      fc.constant('https://evil.com/steal'),
      fc.constant('//evil.com'),
      fc.constant('javascript:alert(1)'),
      fc.webUrl(),
      fc.string(),
    );

    fc.assert(
      fc.property(urlArb, allowlistArb, (url, allowlist) => {
        const result = sanitizeRedirectUrl(url, allowlist);

        // The result must start with one of the allowlist prefixes
        const isAllowed = allowlist.some((prefix) => result.startsWith(prefix));
        expect(isAllowed).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('Property 5 (fallback): undefined or empty url returns allowlist[0]', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(undefined), fc.constant('')),
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 5 }),
        (url, allowlist) => {
          const result = sanitizeRedirectUrl(url, allowlist);
          expect(result).toBe(allowlist[0]);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('Property 5 (passthrough): allowlisted url is returned unchanged', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 0, max: 4 }),
        fc.string(),
        (allowlist, idx, suffix) => {
          const prefix = allowlist[Math.min(idx, allowlist.length - 1)]!;
          const url = prefix + suffix;
          const result = sanitizeRedirectUrl(url, allowlist);
          expect(result).toBe(url);
        },
      ),
      { numRuns: 200 },
    );
  });
});
