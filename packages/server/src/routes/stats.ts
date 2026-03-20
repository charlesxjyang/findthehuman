import type { FastifyInstance } from 'fastify';
import { db } from '../db/connection.js';
import { users, games } from '../db/schema.js';
import { eq, sql, count } from 'drizzle-orm';
import { getRedis } from '../redis.js';

export async function statsRoutes(fastify: FastifyInstance) {
  fastify.get('/stats', async () => {
    const redis = getRedis();

    // Count registered bots and humans from Postgres
    const [botCount] = await db
      .select({ count: count() })
      .from(users)
      .where(eq(users.type, 'bot'));

    const [humanCount] = await db
      .select({ count: count() })
      .from(users)
      .where(eq(users.type, 'human'));

    const [gameCount] = await db.select({ count: count() }).from(games);

    // Scan Redis for active rooms
    const roomKeys = await redis.keys('room:*');
    // Filter to only room hash keys (not :participants, :messages, :votes)
    const roomIds = [
      ...new Set(
        roomKeys
          .map((k) => {
            const match = k.match(/^room:([^:]+)$/);
            return match ? match[1] : null;
          })
          .filter(Boolean) as string[],
      ),
    ];

    // Get phase for each active room
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
