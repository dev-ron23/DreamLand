-- Migration 001: Create users table
-- Stores Discord user records, upserted on each join attempt.
-- Records are keyed by discord_id (Discord snowflake) which is stable and unique.

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id    VARCHAR(20) UNIQUE NOT NULL,
  username      VARCHAR(32) NOT NULL,
  discriminator VARCHAR(4) NOT NULL DEFAULT '0',
  avatar_hash   VARCHAR(64),
  first_joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
