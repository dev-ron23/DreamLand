/**
 * UserRepository — persists Discord user records and join events.
 *
 * Supports two database backends:
 *   - PostgreSQL (production): accessed via the `pg` package using DATABASE_URL
 *   - SQLite (tests): accessed via `better-sqlite3` injected through the constructor
 *
 * When DATABASE_URL is not configured and no explicit database is injected,
 * all methods resolve immediately as a no-op (Requirement 8.7).
 *
 * Requirements: 8.1, 8.2, 8.6, 8.7
 */

import { DiscordUser, JoinEvent, StoredUser } from '../types';

// ---------------------------------------------------------------------------
// Database abstraction — minimal interface shared by pg and better-sqlite3
// ---------------------------------------------------------------------------

/**
 * A row returned from a query, typed as a plain object with string keys.
 */
type Row = Record<string, unknown>;

/**
 * Minimal async query interface satisfied by both the pg `Pool` and our
 * SQLite adapter (see `SqliteAdapter` below).
 */
export interface DbAdapter {
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

// ---------------------------------------------------------------------------
// SQLite adapter — wraps better-sqlite3's synchronous API in the async shape
// ---------------------------------------------------------------------------

/**
 * Wraps a `better-sqlite3` Database instance so it satisfies `DbAdapter`.
 * SQLite executes synchronously; we wrap results in resolved promises so the
 * repository code stays uniform.
 */
export class SqliteAdapter implements DbAdapter {
  // We use `unknown` here to avoid importing better-sqlite3 types at the
  // module level — the adapter is only instantiated in tests.
  constructor(private readonly db: BetterSqlite3Database) {}

  query(sql: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
    // Translate PostgreSQL positional placeholders ($1, $2, …) to SQLite's ?
    const sqliteSql = sql.replace(/\$\d+/g, '?');

    // Determine whether this is a SELECT or a mutating statement
    const trimmed = sqliteSql.trimStart().toUpperCase();
    if (trimmed.startsWith('SELECT')) {
      const stmt = this.db.prepare(sqliteSql);
      const rows = stmt.all(...params) as Row[];
      return Promise.resolve({ rows });
    } else {
      const stmt = this.db.prepare(sqliteSql);
      stmt.run(...params);
      return Promise.resolve({ rows: [] });
    }
  }
}

/**
 * Minimal type for the better-sqlite3 Database object.
 * Declared here to avoid a hard import dependency in production bundles.
 */
interface BetterSqlite3Database {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL adapter factory — lazy-loaded to avoid requiring `pg` in tests
// ---------------------------------------------------------------------------

/**
 * Creates a DbAdapter backed by a `pg.Pool` connected to `databaseUrl`.
 * The `pg` module is required dynamically so that test environments that only
 * have `better-sqlite3` available do not fail at import time.
 */
async function createPgAdapter(databaseUrl: string): Promise<DbAdapter> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require('pg') as typeof import('pg');
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    query(sql: string, params?: unknown[]) {
      return pool.query(sql, params as unknown[]);
    },
  };
}

// ---------------------------------------------------------------------------
// UserRepository
// ---------------------------------------------------------------------------

export class UserRepository {
  /**
   * The underlying database adapter, or `null` when operating in no-op mode
   * (DATABASE_URL not configured and no adapter injected).
   */
  private db: DbAdapter | null;

  /**
   * Resolves to `true` once the PostgreSQL adapter has been initialised.
   * Used to lazily connect on first use.
   */
  private pgInitPromise: Promise<void> | null = null;

  /**
   * @param dbOrUrl - Optional. Pass a `DbAdapter` directly (e.g. a
   *   `SqliteAdapter` in tests), a PostgreSQL connection URL string, or omit
   *   to fall back to `config.DATABASE_URL`. When no database is available
   *   the repository operates as a no-op.
   */
  constructor(dbOrUrl?: DbAdapter | string) {
    if (dbOrUrl === undefined) {
      // Lazy-load config to avoid requiring all env vars in test environments
      let databaseUrl: string | undefined;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { config } = require('../config') as { config: { DATABASE_URL?: string } };
        databaseUrl = config.DATABASE_URL;
      } catch {
        databaseUrl = undefined;
      }

      if (databaseUrl) {
        // Will be initialised lazily on first method call
        this.db = null;
        this.pgInitPromise = createPgAdapter(databaseUrl).then((adapter) => {
          this.db = adapter;
        });
      } else {
        // No database configured — operate as no-op
        this.db = null;
      }
    } else if (typeof dbOrUrl === 'string') {
      // Explicit connection URL provided
      this.db = null;
      this.pgInitPromise = createPgAdapter(dbOrUrl).then((adapter) => {
        this.db = adapter;
      });
    } else {
      // Explicit adapter provided (e.g. SqliteAdapter in tests)
      this.db = dbOrUrl;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Waits for the PostgreSQL adapter to initialise (if applicable) and returns
   * the adapter, or `null` when operating in no-op mode.
   */
  private async getDb(): Promise<DbAdapter | null> {
    if (this.pgInitPromise) {
      await this.pgInitPromise;
      this.pgInitPromise = null;
    }
    return this.db;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Inserts or updates the `users` row for the given Discord user.
   *
   * On conflict (same `discord_id`), updates `username`, `avatar_hash`,
   * `last_seen_at`, and `updated_at`. The `first_joined_at` and `created_at`
   * columns are immutable after the initial insert.
   *
   * Requirements: 8.1
   */
  async upsertUser(user: DiscordUser): Promise<void> {
    const db = await this.getDb();
    if (!db) return; // no-op

    const now = new Date().toISOString();

    await db.query(
      `INSERT INTO users (discord_id, username, discriminator, avatar_hash, first_joined_at, last_seen_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (discord_id) DO UPDATE
         SET username    = EXCLUDED.username,
             avatar_hash = EXCLUDED.avatar_hash,
             last_seen_at = EXCLUDED.last_seen_at,
             updated_at  = EXCLUDED.updated_at`,
      [
        user.id,
        user.username,
        user.discriminator,
        user.avatar ?? null,
        now,
        now,
        now,
        now,
      ],
    );
  }

  /**
   * Appends an immutable join-event record to the `join_events` table.
   *
   * Records are never updated or deleted (append-only analytics log).
   *
   * Requirements: 8.2, 8.6
   */
  async recordJoinEvent(
    event: Omit<JoinEvent, 'id' | 'created_at'>,
  ): Promise<void> {
    const db = await this.getDb();
    if (!db) return; // no-op

    const now = new Date().toISOString();

    await db.query(
      `INSERT INTO join_events (discord_id, result, ip_hash, user_agent_hash, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [event.discord_id, event.result, event.ip_hash, event.user_agent_hash, now],
    );
  }

  /**
   * Looks up a user by their Discord snowflake ID.
   *
   * Returns `null` when no matching row exists.
   *
   * Requirements: 8.1
   */
  async findUserById(discordId: string): Promise<StoredUser | null> {
    const db = await this.getDb();
    if (!db) return null; // no-op

    const result = await db.query(
      `SELECT id, discord_id, username, discriminator, avatar_hash,
              first_joined_at, last_seen_at, created_at, updated_at
       FROM users
       WHERE discord_id = $1`,
      [discordId],
    );

    if (result.rows.length === 0) return null;

    return rowToStoredUser(result.rows[0]);
  }
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

/**
 * Converts a raw database row into a typed `StoredUser` object.
 * Handles both PostgreSQL (returns native Date objects) and SQLite (returns
 * ISO-8601 strings) column values.
 */
function rowToStoredUser(row: Row): StoredUser {
  return {
    id: row['id'] as string,
    discord_id: row['discord_id'] as string,
    username: row['username'] as string,
    discriminator: row['discriminator'] as string,
    avatar_hash: (row['avatar_hash'] as string | null) ?? null,
    first_joined_at: toDate(row['first_joined_at']),
    last_seen_at: toDate(row['last_seen_at']),
    created_at: toDate(row['created_at']),
    updated_at: toDate(row['updated_at']),
  };
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  return new Date(value as string);
}
