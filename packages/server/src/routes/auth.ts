import type { FastifyInstance } from 'fastify';
import { db } from '../db/connection.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { getRedis } from '../redis.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export async function authRoutes(fastify: FastifyInstance) {
  // Request a magic code (in production, this would send an email)
  fastify.post('/auth/request-code', async (request, reply) => {
    const { email, display_name } = request.body as {
      email: string;
      display_name: string;
    };

    if (!email || !display_name) {
      return reply.code(400).send({ error: 'email and display_name are required' });
    }

    // Generate a 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Store code in Redis with 10-min TTL
    const redis = getRedis();
    await redis.set(`auth:code:${email}`, code, 'EX', 600);

    // In development, log the code. In production, send via email.
    fastify.log.info(`Magic code for ${email}: ${code}`);

    return { message: 'Code sent', code: process.env.NODE_ENV !== 'production' ? code : undefined };
  });

  // Verify code and get JWT
  fastify.post('/auth/verify-code', async (request, reply) => {
    const { email, code, display_name } = request.body as {
      email: string;
      code: string;
      display_name: string;
    };

    if (!email || !code) {
      return reply.code(400).send({ error: 'email and code are required' });
    }

    const redis = getRedis();
    const storedCode = await redis.get(`auth:code:${email}`);

    if (!storedCode || storedCode !== code) {
      return reply.code(401).send({ error: 'Invalid or expired code' });
    }

    // Delete used code
    await redis.del(`auth:code:${email}`);

    // Find or create user
    let [user] = await db.select().from(users).where(eq(users.email, email));

    if (!user) {
      [user] = await db
        .insert(users)
        .values({
          type: 'human',
          displayName: display_name || email.split('@')[0],
          email,
        })
        .returning();
    }

    const token = jwt.sign({ userId: user.id, type: 'human' }, JWT_SECRET, {
      expiresIn: '7d',
    });

    return {
      token,
      user: {
        id: user.id,
        display_name: user.displayName,
        elo: user.elo,
        games_played: user.gamesPlayed,
      },
    };
  });

  // Get current user from token
  fastify.get('/auth/me', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing token' });
    }

    try {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET) as { userId: string };
      const [user] = await db.select().from(users).where(eq(users.id, payload.userId));

      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }

      return {
        id: user.id,
        display_name: user.displayName,
        elo: user.elo,
        games_played: user.gamesPlayed,
      };
    } catch {
      return reply.code(401).send({ error: 'Invalid token' });
    }
  });
}
