/**
 * Shared TypeScript types and interfaces for the Discord OAuth2 Join Flow.
 */

// ---------------------------------------------------------------------------
// Discord API Models
// ---------------------------------------------------------------------------

/**
 * User object returned by Discord's /users/@me endpoint.
 * Requirements: 5.2
 */
export interface DiscordUser {
  /** Discord snowflake ID (17–19 digit numeric string) */
  id: string;
  username: string;
  discriminator: string;
  avatar: string | null;
  /** Only present if the email scope was requested (not used in this flow) */
  email?: string;
}

/**
 * Token response returned by Discord's OAuth2 token endpoint.
 * Requirements: 4.2
 */
export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  /** Seconds until the access token expires (typically 604800 = 7 days) */
  expires_in: number;
  refresh_token: string;
  /** Space-separated list of granted scopes, e.g. "identify guilds.join" */
  scope: string;
}

// ---------------------------------------------------------------------------
// Database Models
// ---------------------------------------------------------------------------

/**
 * User record persisted in the `users` table.
 */
export interface StoredUser {
  /** Internal UUID primary key */
  id: string;
  /** Discord snowflake (unique index) */
  discord_id: string;
  username: string;
  discriminator: string;
  avatar_hash: string | null;
  first_joined_at: Date;
  last_seen_at: Date;
  created_at: Date;
  updated_at: Date;
}

/**
 * Immutable join-event record persisted in the `join_events` table.
 * Records are append-only and must never be updated or deleted.
 */
export interface JoinEvent {
  /** UUID primary key */
  id: string;
  /** Foreign key → StoredUser.discord_id */
  discord_id: string;
  result: 'added' | 'already_member';
  /** SHA-256 of IP + IP_HASH_SALT — raw IP is never stored */
  ip_hash: string;
  /** SHA-256 of User-Agent + UA_HASH_SALT — raw UA is never stored */
  user_agent_hash: string;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// OAuth2 Flow State
// ---------------------------------------------------------------------------

/**
 * Ephemeral OAuth2 state payload stored in a signed cookie during the flow.
 * Requirements: 2.2, 3.1, 10.3
 */
export interface OAuthState {
  /** 64-character cryptographically random hex string (CSRF token) */
  token: string;
  /** Unix timestamp in milliseconds — used to enforce 10-minute expiry */
  createdAt: number;
  /** Optional post-join redirect URL; must be validated against the allowlist */
  returnTo?: string;
}

// ---------------------------------------------------------------------------
// Discord API Service Parameters / Results
// ---------------------------------------------------------------------------

/**
 * Parameters for adding a user to a Discord guild.
 * Requirements: 6.1
 */
export interface AddGuildMemberParams {
  guildId: string;
  userId: string;
  accessToken: string;
  /** Optional role IDs to assign to the new member */
  roles?: string[];
  /** Optional nickname to set for the new member */
  nick?: string;
}

/**
 * Result of a guild member addition attempt.
 * Requirements: 6.2, 6.3
 */
export type AddGuildMemberResult = 'added' | 'already_member';

// ---------------------------------------------------------------------------
// Custom Error Classes
// ---------------------------------------------------------------------------

/**
 * Base error for OAuth2 flow failures (token exchange, scope validation, etc.).
 * Requirements: 4.3, 4.4
 */
export class OAuthError extends Error {
  constructor(
    message: string,
    /** Optional Discord error code from the token endpoint response */
    public readonly discordError?: string,
  ) {
    super(message);
    this.name = 'OAuthError';
    // Restore prototype chain for instanceof checks in transpiled code
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when Discord's API responds with HTTP 429 (Too Many Requests).
 * Requirements: 6.4
 */
export class RateLimitError extends Error {
  constructor(
    message: string,
    /** Value of the Retry-After header (seconds) */
    public readonly retryAfter: number,
  ) {
    super(message);
    this.name = 'RateLimitError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when Discord's API responds with HTTP 403 (Forbidden).
 * Indicates the bot lacks the required permissions to add members.
 * Requirements: 6.5
 */
export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown for unexpected Discord API errors (non-200/201/204/403/429 responses).
 * Carries the HTTP status code and raw response body for diagnostics.
 */
export class DiscordApiError extends Error {
  constructor(
    message: string,
    /** HTTP status code returned by the Discord API */
    public readonly statusCode: number,
    /** Parsed response body from the Discord API */
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'DiscordApiError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
