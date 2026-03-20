import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  jsonb,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull().$type<'human' | 'bot'>(),
    displayName: text('display_name').notNull(),
    email: text('email').unique(),
    githubId: text('github_id').unique(),
    googleId: text('google_id').unique(),
    openclawUuid: text('openclaw_uuid').unique(),
    apiKeyHash: text('api_key_hash'),
    elo: integer('elo').notNull().default(1200),
    gamesPlayed: integer('games_played').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    eloIdx: index('idx_users_elo').on(table.elo),
    typeIdx: index('idx_users_type').on(table.type),
  }),
);

export const games = pgTable('games', {
  id: uuid('id').primaryKey().defaultRandom(),
  topic: text('topic').notNull(),
  humanId: uuid('human_id').references(() => users.id),
  humanStealthScore: real('human_stealth_score'),
  roomSize: integer('room_size').notNull().default(6),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
});

export const gameParticipants = pgTable(
  'game_participants',
  {
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().$type<'human' | 'bot'>(),
    handle: text('handle').notNull(),
    rawLogits: jsonb('raw_logits').$type<number[]>(),
    normalizedProbs: jsonb('normalized_probs').$type<number[]>(),
    detectionScore: real('detection_score'),
    eloBefore: integer('elo_before'),
    eloAfter: integer('elo_after'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.gameId, table.userId] }),
    userIdx: index('idx_game_participants_user').on(table.userId),
  }),
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    gameIdx: index('idx_messages_game').on(table.gameId),
  }),
);
