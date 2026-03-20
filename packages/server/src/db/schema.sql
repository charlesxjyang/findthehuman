-- Find the Human — Database Schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('human', 'bot')),
  display_name TEXT NOT NULL,
  email TEXT UNIQUE,
  github_id TEXT UNIQUE,
  google_id TEXT UNIQUE,
  openclaw_uuid TEXT UNIQUE,
  api_key_hash TEXT,
  elo INTEGER NOT NULL DEFAULT 1200,
  games_played INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE games (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic TEXT NOT NULL,
  human_id UUID REFERENCES users(id),
  human_stealth_score REAL,
  room_size INTEGER NOT NULL DEFAULT 6,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);

CREATE TABLE game_participants (
  game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('human', 'bot')),
  handle TEXT NOT NULL,
  raw_logits JSONB,
  normalized_probs JSONB,
  detection_score REAL,
  elo_before INTEGER,
  elo_after INTEGER,
  PRIMARY KEY (game_id, user_id)
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  posted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_game_participants_user ON game_participants(user_id);
CREATE INDEX idx_messages_game ON messages(game_id);
CREATE INDEX idx_users_elo ON users(elo DESC);
CREATE INDEX idx_users_type ON users(type);
