import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/connection.js';
import { users } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { getRoom, joinRoom, getMessages, addMessage, submitVote } from '../rooms.js';
import { randomBytes, createHash } from 'node:crypto';

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

    // Get available rooms
    authedRoutes.get('/agents/rooms/available', async (request) => {
      // For now, return rooms in lobby state from Redis
      // This is a simplified implementation — in production you'd scan Redis keys
      return [];
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

      const { joined, participantCount } = await joinRoom(roomId, bot.id);
      if (!joined) {
        return reply.code(400).send({ error: 'Failed to join room' });
      }

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

      if (!content || typeof content !== 'string') {
        return reply.code(400).send({ error: 'content is required' });
      }

      if (content.length > 2000) {
        return reply.code(400).send({ error: 'Message too long (max 2000 chars)' });
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
        io.to(`room:${roomId}`).emit('room:message', {
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
  });
}
