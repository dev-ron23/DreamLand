/**
 * OAuth utility functions for the Discord OAuth2 Join Flow.
 *
 * This module provides pure, side-effect-free helpers used by the
 * OAuthController and other parts of the application.
 *
 * Requirements: 2.1, 2.3, 3.1, 3.2, 3.3, 8.3, 8.4, 10.2, 10.4, 10.6,
 *               12.1, 12.2, 12.3, 12.4, 14.1, 14.2, 14.3
 */

import crypto from 'crypto';
import { config } from '../config';
import type { OAuthState } from '../types';

// ---------------------------------------------------------------------------
// 4.1 — generateStateToken
// ---------------------------------------------------------------------------

/**
 * Generates a cryptographically random 64-character lowercase hex string
 * suitable for use as an OAuth2 CSRF state token.
 *
 * Requirements: 2.1, 10.2
 */
export function generateStateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// 4.3 — buildAuthorizationUrl
// ---------------------------------------------------------------------------

const DISCORD_AUTHORIZE_BASE = 'https://discord.com/oauth2/authorize';

/**
 * Constructs the Discord OAuth2 authorization URL with all required query
 * parameters.
 *
 * @param stateToken - A 64-character hex CSRF token produced by
 *   `generateStateToken()`.
 * @returns A fully-formed HTTPS URL to redirect the user to.
 *
 * Requirements: 2.3
 */
export function buildAuthorizationUrl(stateToken: string): string {
  const params = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    redirect_uri: config.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.join',
    state: stateToken,
    prompt: 'consent',
  });

  return `${DISCORD_AUTHORIZE_BASE}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// 4.5 — validateState
// ---------------------------------------------------------------------------

/** Maximum age of an OAuth2 state cookie in milliseconds (10 minutes). */
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Validates the OAuth2 CSRF state by comparing the signed cookie value
 * against the `state` query parameter returned by Discord.
 *
 * The `cookieValue` is expected to be a JSON-serialised `OAuthState` object
 * (i.e. the raw value of the signed cookie after signature verification has
 * already been performed by `cookie-parser`).
 *
 * @param cookieValue  - Raw JSON string from the `oauth_state` signed cookie,
 *   or `undefined` if the cookie is absent / signature is invalid.
 * @param queryState   - The `state` query parameter from the callback URL,
 *   or `undefined` if it was not present.
 * @returns `{ valid: true }` when all checks pass, or
 *   `{ valid: false, reason: 'missing' | 'expired' | 'mismatch' }` otherwise.
 *
 * Requirements: 3.1, 3.2, 3.3, 10.4, 10.6
 */
export function validateState(
  cookieValue: string | undefined,
  queryState: string | undefined,
): { valid: boolean; reason?: string } {
  // Either argument absent → missing
  if (!cookieValue || !queryState) {
    return { valid: false, reason: 'missing' };
  }

  // Parse the JSON-serialised OAuthState stored in the cookie
  let state: OAuthState;
  try {
    state = JSON.parse(cookieValue) as OAuthState;
  } catch {
    return { valid: false, reason: 'missing' };
  }

  // Validate required fields exist
  if (!state.token || typeof state.createdAt !== 'number') {
    return { valid: false, reason: 'missing' };
  }

  // Check expiry (> 10 minutes old)
  if (Date.now() - state.createdAt > STATE_MAX_AGE_MS) {
    return { valid: false, reason: 'expired' };
  }

  // Compare tokens
  if (state.token !== queryState) {
    return { valid: false, reason: 'mismatch' };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// 4.6 — hashForAnalytics
// ---------------------------------------------------------------------------

/**
 * Computes a SHA-256 hash of `value + salt` and returns a 64-character
 * lowercase hexadecimal string.
 *
 * Used to produce privacy-preserving hashes of IP addresses and User-Agent
 * strings for analytics storage.
 *
 * Requirements: 8.3, 8.4, 14.1, 14.2, 14.3
 */
export function hashForAnalytics(value: string, salt: string): string {
  return crypto.createHash('sha256').update(value + salt).digest('hex');
}

// ---------------------------------------------------------------------------
// 4.8 — sanitizeRedirectUrl
// ---------------------------------------------------------------------------

/**
 * Validates a redirect URL against an allowlist of permitted prefixes.
 *
 * Returns `url` unchanged if it starts with one of the `allowlist` entries.
 * Falls back to `allowlist[0]` when `url` is undefined, empty, or does not
 * match any allowlist prefix — preventing open redirect vulnerabilities.
 *
 * @param url       - Candidate redirect URL (may be undefined or arbitrary).
 * @param allowlist - Non-empty array of permitted URL prefixes.
 * @returns A safe redirect URL that is guaranteed to be in the allowlist.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4
 */
export function sanitizeRedirectUrl(
  url: string | undefined,
  allowlist: string[],
): string {
  if (url && allowlist.some((prefix) => url.startsWith(prefix))) {
    return url;
  }
  return allowlist[0]!;
}
