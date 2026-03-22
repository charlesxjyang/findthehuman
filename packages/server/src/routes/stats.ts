import type { FastifyInstance } from 'fastify';
import { db } from '../db/connection.js';
import { users, games } from '../db/schema.js';
import { eq, count } from 'drizzle-orm';
import { getRedis } from '../redis.js';
import { getActiveRoomIds } from '../rooms.js';

export interface QuickStats {
  registered_bots: number;
  active_rooms: number;
  players_waiting: number;
}

let cachedStats: QuickStats | null = null;
let cacheTime = 0;
const CACHE_TTL = 5_000; // 5 seconds

export async function getQuickStats(): Promise<QuickStats> {
  const now = Date.now();
  if (cachedStats && now - cacheTime < CACHE_TTL) {
    return cachedStats;
  }

  const redis = getRedis();

  const [botCount] = await db
    .select({ count: count() })
    .from(users)
    .where(eq(users.type, 'bot'));

  const roomIds = await getActiveRoomIds();

  let activeRooms = 0;
  let playersWaiting = 0;
  for (const roomId of roomIds) {
    const phase = await redis.hget(`room:${roomId}`, 'phase');
    if (phase && phase !== 'complete') {
      activeRooms++;
      if (phase === 'lobby') {
        const count = await redis.scard(`room:${roomId}:participants`);
        playersWaiting += count;
      }
    }
  }

  cachedStats = {
    registered_bots: botCount.count,
    active_rooms: activeRooms,
    players_waiting: playersWaiting,
  };
  cacheTime = now;
  return cachedStats;
}

export async function statsRoutes(fastify: FastifyInstance) {
  fastify.get('/stats', async () => {
    const redis = getRedis();

    const [botCount] = await db
      .select({ count: count() })
      .from(users)
      .where(eq(users.type, 'bot'));

    const [humanCount] = await db
      .select({ count: count() })
      .from(users)
      .where(eq(users.type, 'human'));

    const [gameCount] = await db.select({ count: count() }).from(games);

    const roomIds = await getActiveRoomIds();

    const activeRooms: Array<{ id: string; phase: string; participants: number }> = [];
    for (const roomId of roomIds) {
      const phase = await redis.hget(`room:${roomId}`, 'phase');
      const participantCount = await redis.scard(`room:${roomId}:participants`);
      if (phase) {
        activeRooms.push({ id: roomId, phase, participants: participantCount });
      }
    }

    const lobbies = activeRooms.filter((r) => r.phase === 'lobby');
    const inProgress = activeRooms.filter((r) =>
      ['topic_reveal', 'discussion', 'voting', 'reveal'].includes(r.phase),
    );

    return {
      registered_bots: botCount.count,
      registered_humans: humanCount.count,
      total_games_played: gameCount.count,
      active_rooms: {
        total: activeRooms.length,
        waiting_in_lobby: lobbies.length,
        in_progress: inProgress.length,
        details: activeRooms,
      },
    };
  });
}
