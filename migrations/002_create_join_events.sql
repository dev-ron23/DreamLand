-- Migration 002: Create join_events table
-- Stores immutable, append-only records of each join attempt.
-- Records are never updated or deleted (privacy-preserving analytics).
-- ip_hash and user_agent_hash are SHA-256 digests — raw values are never stored.

CREATE TABLE join_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id    VARCHAR(20) NOT NULL REFERENCES users(discord_id),
  result        VARCHAR(20) NOT NULL CHECK (result IN ('added', 'already_member')),
  ip_hash       VARCHAR(64) NOT NULL,
  user_agent_hash VARCHAR(64) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_join_events_discord_id ON join_events(discord_id);
CREATE INDEX idx_join_events_created_at ON join_events(created_at);
