/**
 * Unit tests for UserRepository.
 *
 * Uses an in-memory SQLite database (better-sqlite3) via SqliteAdapter so
 * tests run without a real PostgreSQL instance.
 *
 * Test coverage:
 *   - upsertUser idempotency: calling twice with the same discord_id updates
 *     the row rather than inserting a duplicate (Requirements 8.1, 8.5)
 *   - recordJoinEvent append-only: multiple calls create multiple rows
 *     (Requirements 8.2, 8.6)
 *   - findUserById: returns the stored user or null (Requirement 8.1)
 *   - no-op when DB is absent: all methods resolve without error (Requirement 8.7)
 */

import Database from 'better-sqlite3';
import { UserRepository, SqliteAdapter } from '../UserRepository';
import { DiscordUser, JoinEvent } from '../../types';

// ---------------------------------------------------------------------------
// SQLite schema — adapted from the PostgreSQL migrations for SQLite
// (no UUID type, no TIMESTAMPTZ — use TEXT for both)
// ---------------------------------------------------------------------------

const CREATE_USERS_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    discord_id    TEXT UNIQUE NOT NULL,
    username      TEXT NOT NULL,
    discriminator TEXT NOT NULL DEFAULT '0',
    avatar_hash   TEXT,
    first_joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

const CREATE_JOIN_EVENTS_SQL = `
  CREATE TABLE IF NOT EXISTS join_events (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    discord_id    TEXT NOT NULL REFERENCES users(discord_id),
    result        TEXT NOT NULL CHECK (result IN ('added', 'already_member')),
    ip_hash       TEXT NOT NULL,
    user_agent_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a fresh in-memory SQLite database with the required schema. */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(CREATE_USERS_SQL);
  db.exec(CREATE_JOIN_EVENTS_SQL);
  return db;
}

/** Returns a UserRepository backed by the given SQLite database. */
function createRepo(db: Database.Database): UserRepository {
  return new UserRepository(new SqliteAdapter(db));
}

/** A minimal valid DiscordUser fixture. */
const baseUser: DiscordUser = {
  id: '123456789012345678',
  username: 'alice',
  discriminator: '0',
  avatar: 'abc123hash',
};

/** A minimal valid join-event fixture (omits id and created_at). */
const baseEvent: Omit<JoinEvent, 'id' | 'created_at'> = {
  discord_id: baseUser.id,
  result: 'added',
  ip_hash: 'a'.repeat(64),
  user_agent_hash: 'b'.repeat(64),
};

// ---------------------------------------------------------------------------
// Tests: upsertUser
// ---------------------------------------------------------------------------

describe('UserRepository.upsertUser', () => {
  test('inserts a new user row on first call', async () => {
    const db = createTestDb();
    const repo = createRepo(db);

    await repo.upsertUser(baseUser);

    const rows = db.prepare('SELECT * FROM users WHERE discord_id = ?').all(baseUser.id);
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>)['username']).toBe('alice');
  });

  test('updates username and avatar_hash on second call (idempotency)', async () => {
    const db = createTestDb();
    const repo = createRepo(db);

    await repo.upsertUser(baseUser);

    const updatedUser: DiscordUser = {
      ...baseUser,
      username: 'alice_updated',
      avatar: 'newhash999',
    };
    await repo.upsertUser(updatedUser);

    const rows = db.prepare('SELECT * FROM users WHERE discord_id = ?').all(baseUser.id);
    // Must still be exactly one row — no duplicate inserted
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>)['username']).toBe('alice_updated');
    expect((rows[0] as Record<string, unknown>)['avatar_hash']).toBe('newhash999');
  });

  test('does not change first_joined_at on subsequent upserts', async () => {
    const db = createTestDb();
    const repo = createRepo(db);

    await repo.upsertUser(baseUser);
    const firstRow = db
      .prepare('SELECT first_joined_at FROM users WHERE discord_id = ?')
      .get(baseUser.id) as Record<string, unknown>;
    const firstJoinedAt = firstRow['first_joined_at'];

    // Small delay to ensure timestamps would differ if re-written
    await new Promise((r) => setTimeout(r, 10));
    await repo.upsertUser({ ...baseUser, username: 'alice_v2' });

    const secondRow = db
      .prepare('SELECT first_joined_at FROM users WHERE discord_id = ?')
      .get(baseUser.id) as Record<string, unknown>;
    expect(secondRow['first_joined_at']).toBe(firstJoinedAt);
  });

  test('stores null avatar_hash when avatar is null', async () => {
    const db = createTestDb();
    const repo = createRepo(db);

    await repo.upsertUser({ ...baseUser, avatar: null });

    const row = db
      .prepare('SELECT avatar_hash FROM users WHERE discord_id = ?')
      .get(baseUser.id) as Record<string, unknown>;
    expect(row['avatar_hash']).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: recordJoinEvent
// ---------------------------------------------------------------------------

describe('UserRepository.recordJoinEvent', () => {
  test('inserts a join event row', async () => {
    const db = createTestDb();
    const repo = createRepo(db);

    await repo.upsertUser(baseUser);
    await repo.recordJoinEvent(baseEvent);

    const rows = db
      .prepare('SELECT * FROM join_events WHERE discord_id = ?')
      .all(baseUser.id);
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>)['result']).toBe('added');
  });

  test('append-only: multiple calls create multiple rows', async () => {
    const db = createTestDb();
    const repo = createRepo(db);

    await repo.upsertUser(baseUser);
    await repo.recordJoinEvent(baseEvent);
    await repo.recordJoinEvent({ ...baseEvent, result: 'already_member' });
    await repo.recordJoinEvent(baseEvent);

    const rows = db
      .prepare('SELECT * FROM join_events WHERE discord_id = ?')
      .all(baseUser.id);
    expect(rows).toHaveLength(3);
  });

  test('stores the correct result value', async () => {
    const db = createTestDb();
    const repo = createRepo(db);

    await repo.upsertUser(baseUser);
    await repo.recordJoinEvent({ ...baseEvent, result: 'already_member' });

    const row = db
      .prepare('SELECT result FROM join_events WHERE discord_id = ?')
      .get(baseUser.id) as Record<string, unknown>;
    expect(row['result']).toBe('already_member');
  });

  test('stores ip_hash and user_agent_hash', async () => {
    const db = createTestDb();
    const repo = createRepo(db);

    await repo.upsertUser(baseUser);
    await repo.recordJoinEvent(baseEvent);

    const row = db
      .prepare('SELECT ip_hash, user_agent_hash FROM join_events WHERE discord_id = ?')
      .get(baseUser.id) as Record<string, unknown>;
    expect(row['ip_hash']).toBe('a'.repeat(64));
    expect(row['user_agent_hash']).toBe('b'.repeat(64));
  });
});

// ---------------------------------------------------------------------------
// Tests: findUserById
// ---------------------------------------------------------------------------

describe('UserRepository.findUserById', () => {
  test('returns null when user does not exist', async () => {
    const db = createTestDb();
    const repo = createRepo(db);

    const result = await repo.findUserById('nonexistent');
    expect(result).toBeNull();
  });

  test('returns the stored user when found', async () => {
    const db = createTestDb();
    const repo = createRepo(db);

    await repo.upsertUser(baseUser);
    const result = await repo.findUserById(baseUser.id);

    expect(result).not.toBeNull();
    expect(result!.discord_id).toBe(baseUser.id);
    expect(result!.username).toBe('alice');
    expect(result!.discriminator).toBe('0');
    expect(result!.avatar_hash).toBe('abc123hash');
  });

  test('returns updated fields after upsert', async () => {
    const db = createTestDb();
    const repo = createRepo(db);

    await repo.upsertUser(baseUser);
    await repo.upsertUser({ ...baseUser, username: 'alice_new', avatar: null });

    const result = await repo.findUserById(baseUser.id);
    expect(result!.username).toBe('alice_new');
    expect(result!.avatar_hash).toBeNull();
  });

  test('returned dates are Date instances', async () => {
    const db = createTestDb();
    const repo = createRepo(db);

    await repo.upsertUser(baseUser);
    const result = await repo.findUserById(baseUser.id);

    expect(result!.first_joined_at).toBeInstanceOf(Date);
    expect(result!.last_seen_at).toBeInstanceOf(Date);
    expect(result!.created_at).toBeInstanceOf(Date);
    expect(result!.updated_at).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// Tests: no-op when DATABASE_URL is not configured (Requirement 8.7)
// ---------------------------------------------------------------------------

describe('UserRepository — no-op mode (no database)', () => {
  /**
   * Create a repository with no adapter and no DATABASE_URL.
   * We temporarily clear DATABASE_URL from the environment to simulate the
   * "no database configured" scenario without touching the real config module.
   */
  function createNoOpRepo(): UserRepository {
    // Pass no argument; the constructor will find no DATABASE_URL and no
    // injected adapter, so it will operate as a no-op.
    // We bypass the config module by passing `undefined` explicitly and
    // ensuring the env var is absent.
    const saved = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    // Also clear the require cache for config so it re-evaluates
    try {
      // Instantiate with no args — constructor reads DATABASE_URL from config
      // We use a direct null-adapter approach instead to keep tests isolated:
      // pass a special sentinel that forces no-op mode.
      return new (class extends UserRepository {
        constructor() {
          // Call parent with undefined to trigger the no-DATABASE_URL path,
          // but we need to ensure config.DATABASE_URL is undefined.
          // Simplest: pass a custom adapter that is null-like.
          // Actually, the cleanest approach is to test the no-op by not
          // passing any adapter and ensuring DATABASE_URL is unset.
          super(undefined as unknown as string);
          // Force the db to null to simulate no-op
          (this as unknown as { db: null }).db = null;
          (this as unknown as { pgInitPromise: null }).pgInitPromise = null;
        }
      })();
    } finally {
      if (saved !== undefined) {
        process.env['DATABASE_URL'] = saved;
      }
    }
  }

  test('upsertUser resolves without error when no DB is configured', async () => {
    const repo = createNoOpRepo();
    await expect(repo.upsertUser(baseUser)).resolves.toBeUndefined();
  });

  test('recordJoinEvent resolves without error when no DB is configured', async () => {
    const repo = createNoOpRepo();
    await expect(repo.recordJoinEvent(baseEvent)).resolves.toBeUndefined();
  });

  test('findUserById returns null when no DB is configured', async () => {
    const repo = createNoOpRepo();
    await expect(repo.findUserById(baseUser.id)).resolves.toBeNull();
  });
});
