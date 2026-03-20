import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/connection.js';
import { users, messages, gameParticipants } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { getRoom, joinRoom, getMessages, addMessage, submitVote } from '../rooms.js';
import { checkAndStartRoom } from '../matchmaker.js';
import { randomBytes, createHash } from 'node:crypto';
import { validateMessageContent } from '../validation.js';
import { getRedis } from '../redis.js';

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

async function authenticateBot(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Missing or invalid authorization header' });
    return;
  }

  const apiKey = auth.slice(7);
  const keyHash = hashApiKey(apiKey);

  const [bot] = await db
    .select()
    .from(users)
    .where(and(eq(users.apiKeyHash, keyHash), eq(users.type, 'bot')));

  if (!bot) {
    reply.code(401).send({ error: 'Invalid API key' });
    return;
  }

  (request as any).botUser = bot;
}

export async function agentRoutes(fastify: FastifyInstance) {
  // Register a bot
  fastify.post('/agents/register', async (request, reply) => {
    const { openclaw_uuid, display_name } = request.body as {
      openclaw_uuid: string;
      display_name: string;
    };

    if (!openclaw_uuid || !display_name) {
      return reply.code(400).send({ error: 'openclaw_uuid and display_name are required' });
    }

    // Check if already registered
    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.openclawUuid, openclaw_uuid));

    if (existing) {
      // Generate new API key
      const apiKey = randomBytes(32).toString('hex');
      const keyHash = hashApiKey(apiKey);
      await db.update(users).set({ apiKeyHash: keyHash }).where(eq(users.id, existing.id));

      return { user_id: existing.id, api_key: apiKey };
    }

    // Create new bot user
    const apiKey = randomBytes(32).toString('hex');
    const keyHash = hashApiKey(apiKey);

    const [newUser] = await db
      .insert(users)
      .values({
        type: 'bot',
        displayName: display_name,
        openclawUuid: openclaw_uuid,
        apiKeyHash: keyHash,
      })
      .returning();

    return { user_id: newUser.id, api_key: apiKey };
  });

  // All routes below require auth
  fastify.register(async (authedRoutes) => {
    authedRoutes.addHook('preHandler', authenticateBot);

    // Get available rooms in lobby state
    authedRoutes.get('/agents/rooms/available', async (request) => {
      const redis = getRedis();
      const roomKeys = await redis.keys('room:*');
      const roomIds = [
        ...new Set(
          roomKeys
            .map((k) => { const m = k.match(/^room:([^:]+)$/); return m ? m[1] : null; })
            .filter(Boolean) as string[],
        ),
      ];

      const available: Array<{ room_id: string; topic: string; slots_remaining: number; created_at: string }> = [];
      for (const roomId of roomIds) {
        const phase = await redis.hget(`room:${roomId}`, 'phase');
        if (phase !== 'lobby') continue;
        const topic = await redis.hget(`room:${roomId}`, 'topic') || '';
        const createdAt = await redis.hget(`room:${roomId}`, 'createdAt') || '';
        const count = await redis.scard(`room:${roomId}:participants`);
        const bot = (request as any).botUser;
        const isMember = await redis.sismember(`room:${roomId}:participants`, bot.id);
        if (isMember) continue; // Already in this room
        available.push({
          room_id: roomId,
          topic,
          slots_remaining: 6 - count,
          created_at: createdAt,
        });
      }
      return available;
    });

    // Join a room
    authedRoutes.post('/agents/rooms/:roomId/join', async (request, reply) => {
      const { roomId } = request.params as { roomId: string };
      const bot = (request as any).botUser;

      const room = await getRoom(roomId);
      if (!room) {
        return reply.code(404).send({ error: 'Room not found' });
      }

      if (room.phase !== 'lobby') {
        return reply.code(400).send({ error: 'Room is not in lobby state' });
      }

      if (room.participants.length >= 6) {
        return reply.code(400).send({ error: 'Room is full' });
      }

      const { joined, participantCount } = await joinRoom(roomId, bot.id);
      if (!joined) {
        return reply.code(400).send({ error: 'Failed to join room' });
      }

      // Check if we have enough participants to start
      const io = (fastify as any).io;
      await checkAndStartRoom(roomId, io);

      const updatedRoom = await getRoom(roomId);
      return {
        joined: true,
        room_state: updatedRoom?.phase,
        participants: updatedRoom?.participants.length,
        topic: updatedRoom?.topic,
      };
    });

    // Get messages
    authedRoutes.get('/agents/rooms/:roomId/messages', async (request, reply) => {
      const { roomId } = request.params as { roomId: string };
      const { since } = request.query as { since?: string };

      const room = await getRoom(roomId);
      if (!room) {
        return reply.code(404).send({ error: 'Room not found' });
      }

      const messages = await getMessages(roomId, since);
      // Strip userId from messages, return handle instead
      return messages.map((m) => ({
        id: m.id,
        handle: m.handle,
        content: m.content,
        posted_at: m.postedAt,
      }));
    });

    // Post a message
    authedRoutes.post('/agents/rooms/:roomId/message', async (request, reply) => {
      const { roomId } = request.params as { roomId: string };
      const { content } = request.body as { content: string };
      const bot = (request as any).botUser;

      const validationError = validateMessageContent(content);
      if (validationError) {
        return reply.code(400).send({ error: validationError });
      }

      const room = await getRoom(roomId);
      if (!room) {
        return reply.code(404).send({ error: 'Room not found' });
      }

      if (room.phase !== 'discussion') {
        return reply.code(400).send({ error: 'Room is not in discussion phase' });
      }

      if (!room.participants.includes(bot.id)) {
        return reply.code(403).send({ error: 'Not a participant in this room' });
      }

      const msg = await addMessage(roomId, bot.id, content);

      // Broadcast to WebSocket clients
      const io = (fastify as any).io;
      if (io) {
        io.of('/game').to(`room:${roomId}`).emit('room:message', {
          handle: msg.handle,
          content: msg.content,
          posted_at: msg.postedAt,
        });
      }

      return { message_id: msg.id, posted_at: msg.postedAt };
    });

    // Submit vote
    authedRoutes.post('/agents/rooms/:roomId/vote', async (request, reply) => {
      const { roomId } = request.params as { roomId: string };
      const { logits } = request.body as { logits: number[] };
      const bot = (request as any).botUser;

      const room = await getRoom(roomId);
      if (!room) {
        return reply.code(404).send({ error: 'Room not found' });
      }

      if (room.phase !== 'voting') {
        return reply.code(400).send({ error: 'Room is not in voting phase' });
      }

      if (!room.participants.includes(bot.id)) {
        return reply.code(403).send({ error: 'Not a participant in this room' });
      }

      if (!Array.isArray(logits) || logits.length !== room.participants.length) {
        return reply
          .code(400)
          .send({ error: `logits must be an array of length ${room.participants.length}` });
      }

      if (!logits.every((l) => typeof l === 'number' && Number.isFinite(l))) {
        return reply.code(400).send({ error: 'All logits must be finite numbers' });
      }

      await submitVote(roomId, bot.id, logits);
      return { received: true };
    });

    // Get bot stats
    authedRoutes.get('/agents/me/stats', async (request) => {
      const bot = (request as any).botUser;
      return {
        user_id: bot.id,
        display_name: bot.displayName,
        elo: bot.elo,
        games_played: bot.gamesPlayed,
      };
    });

    // Delete bot account and anonymize data
    authedRoutes.delete('/agents/me', async (request) => {
      const bot = (request as any).botUser;

      // Anonymize messages (replace content, keep structure for game integrity)
      await db
        .update(messages)
        .set({ content: '[deleted]' })
        .where(eq(messages.userId, bot.id));

      // Remove from game participants (keep game records, null out user reference)
      await db
        .update(gameParticipants)
        .set({ rawLogits: null, normalizedProbs: null })
        .where(eq(gameParticipants.userId, bot.id));

      // Delete the user
      await db.delete(users).where(eq(users.id, bot.id));

      return { deleted: true };
    });
  });
}
