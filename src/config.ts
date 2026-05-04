/**
 * Environment configuration loader and validator.
 *
 * This module reads environment variables from `process.env`, validates that
 * all required variables are present, applies defaults for optional variables,
 * and exports a single typed `config` object.
 *
 * NOTE: This module does NOT call `dotenv.config()`. The entry point
 * (`src/server.ts`) must call `dotenv.config()` before importing this module.
 *
 * Requirements: 11.4
 */

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

export interface Config {
  // Required — Discord application credentials
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_REDIRECT_URI: string;
  DISCORD_GUILD_ID: string;
  DISCORD_BOT_TOKEN: string;

  // Required — security secrets
  COOKIE_SECRET: string;
  IP_HASH_SALT: string;
  UA_HASH_SALT: string;

  // Optional — server settings
  PORT: number;
  NODE_ENV: string;

  // Optional — database
  DATABASE_URL: string | undefined;

  // Optional — custom DM feature
  CUSTOM_DM_ENABLED: boolean;
  CUSTOM_WELCOME_MESSAGE: string;

  // Optional — redirect allowlist (parsed from comma-separated string)
  REDIRECT_ALLOWLIST: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the value of an environment variable, throwing a descriptive error
 * if it is absent or empty.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Please set it in your .env file or deployment environment.`,
    );
  }
  return value;
}

/**
 * Returns the value of an optional environment variable, or `defaultValue`
 * when the variable is absent or empty.
 */
function optionalEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value !== undefined && value.trim() !== '' ? value : defaultValue;
}

// ---------------------------------------------------------------------------
// Config factory — separated from the exported singleton so it can be tested
// ---------------------------------------------------------------------------

export function loadConfig(): Config {
  // --- Required variables (throw on missing) ---
  const DISCORD_CLIENT_ID = requireEnv('DISCORD_CLIENT_ID');
  const DISCORD_CLIENT_SECRET = requireEnv('DISCORD_CLIENT_SECRET');
  const DISCORD_REDIRECT_URI = requireEnv('DISCORD_REDIRECT_URI');
  const DISCORD_GUILD_ID = requireEnv('DISCORD_GUILD_ID');
  const DISCORD_BOT_TOKEN = requireEnv('DISCORD_BOT_TOKEN');
  const COOKIE_SECRET = requireEnv('COOKIE_SECRET');
  const IP_HASH_SALT = requireEnv('IP_HASH_SALT');
  const UA_HASH_SALT = requireEnv('UA_HASH_SALT');

  // --- Optional: PORT (default 3000) ---
  const portRaw = optionalEnv('PORT', '3000');
  const PORT = parseInt(portRaw, 10);
  if (isNaN(PORT) || PORT <= 0 || PORT > 65535) {
    throw new Error(
      `Invalid value for environment variable PORT: "${portRaw}". ` +
        `Must be a valid port number between 1 and 65535.`,
    );
  }

  // --- Optional: NODE_ENV (default 'development') ---
  const NODE_ENV = optionalEnv('NODE_ENV', 'development');

  // --- Optional: DATABASE_URL (undefined if not set) ---
  const rawDatabaseUrl = process.env['DATABASE_URL'];
  const DATABASE_URL =
    rawDatabaseUrl !== undefined && rawDatabaseUrl.trim() !== ''
      ? rawDatabaseUrl
      : undefined;

  // --- Optional: CUSTOM_DM_ENABLED (default false) ---
  const CUSTOM_DM_ENABLED =
    optionalEnv('CUSTOM_DM_ENABLED', 'false').toLowerCase() === 'true';

  // --- Optional: CUSTOM_WELCOME_MESSAGE (default 'Welcome!') ---
  const CUSTOM_WELCOME_MESSAGE = optionalEnv(
    'CUSTOM_WELCOME_MESSAGE',
    'Welcome!',
  );

  // --- Optional: REDIRECT_ALLOWLIST (comma-separated, default '/success') ---
  const allowlistRaw = optionalEnv('REDIRECT_ALLOWLIST', '/success');
  const REDIRECT_ALLOWLIST = allowlistRaw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  // Guarantee at least one entry in the allowlist
  if (REDIRECT_ALLOWLIST.length === 0) {
    REDIRECT_ALLOWLIST.push('/success');
  }

  return {
    DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET,
    DISCORD_REDIRECT_URI,
    DISCORD_GUILD_ID,
    DISCORD_BOT_TOKEN,
    COOKIE_SECRET,
    IP_HASH_SALT,
    UA_HASH_SALT,
    PORT,
    NODE_ENV,
    DATABASE_URL,
    CUSTOM_DM_ENABLED,
    CUSTOM_WELCOME_MESSAGE,
    REDIRECT_ALLOWLIST,
  };
}

// ---------------------------------------------------------------------------
// Exported singleton — evaluated once at module load time
// ---------------------------------------------------------------------------

export const config: Config = loadConfig();
