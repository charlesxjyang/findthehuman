import type { FastifyInstance } from 'fastify';
import { db } from '../db/connection.js';
import { users, gameParticipants, games } from '../db/schema.js';
import { eq, desc, and, sql } from 'drizzle-orm';

export async function leaderboardRoutes(fastify: FastifyInstance) {
  // Get leaderboard
  fastify.get('/leaderboard', async (request) => {
    const { type = 'human', page = '1', limit = '20' } = request.query as {
      type?: string;
      page?: string;
      limit?: string;
    };

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const userType = type === 'bot' ? 'bot' : 'human';

    const rows = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        elo: users.elo,
        gamesPlayed: users.gamesPlayed,
        type: users.type,
      })
      .from(users)
      .where(eq(users.type, userType))
      .orderBy(desc(users.elo))
      .limit(limitNum)
      .offset(offset);

    return rows.map((row, i) => ({
      rank: offset + i + 1,
      id: row.id,
      display_name: row.displayName,
      elo: row.elo,
      games_played: row.gamesPlayed,
    }));
  });

  // Get user profile
  fastify.get('/leaderboard/user/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const [user] = await db.select().from(users).where(eq(users.id, id));
    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    // Get recent games with scores
    const recentGames = await db
      .select({
        gameId: gameParticipants.gameId,
        role: gameParticipants.role,
        detectionScore: gameParticipants.detectionScore,
        eloBefore: gameParticipants.eloBefore,
        eloAfter: gameParticipants.eloAfter,
        topic: games.topic,
        endedAt: games.endedAt,
        humanStealthScore: games.humanStealthScore,
      })
      .from(gameParticipants)
      .innerJoin(games, eq(gameParticipants.gameId, games.id))
      .where(eq(gameParticipants.userId, id))
      .orderBy(desc(games.endedAt))
      .limit(20);

    return {
      id: user.id,
      display_name: user.displayName,
      type: user.type,
      elo: user.elo,
      games_played: user.gamesPlayed,
      openclaw_uuid: user.openclawUuid,
      recent_games: recentGames.map((g) => ({
        game_id: g.gameId,
        topic: g.topic,
        role: g.role,
        detection_score: g.detectionScore,
        elo_before: g.eloBefore,
        elo_after: g.eloAfter,
        human_stealth_score: g.humanStealthScore,
        ended_at: g.endedAt,
      })),
    };
  });
}
