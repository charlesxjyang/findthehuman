import type { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { matchHuman } from '../matchmaker.js';
import { getRoom, addMessage } from '../rooms.js';
import { getQuickStats } from './stats.js';
import { validateMessageContent } from '../validation.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const MATCH_POLL_INTERVAL = 5_000; // 5 seconds
const MATCH_TIMEOUT = 120_000; // 2 minutes

interface AuthPayload {
  userId: string;
  type: 'human';
}

export function setupWebSocket(io: Server) {
  const gameNsp = io.of('/game');

  gameNsp.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const payload = jwt.verify(token, JWT_SECRET) as AuthPayload;
      (socket as any).userId = payload.userId;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  gameNsp.on('connection', (socket: Socket) => {
    const userId = (socket as any).userId as string;

    // Human joins matchmaking queue
    socket.on('queue', async () => {
      try {
        const stats = await getQuickStats();
        socket.emit('room:status', { status: 'waiting_for_bots', ...stats });

        const roomId = await matchHuman(userId);
        if (!roomId) {
          socket.emit('room:error', { message: 'Failed to create room' });
          return;
        }

        // Join the Socket.io room — wait for bots to join and startGame to fire
        socket.join(`room:${roomId}`);
        (socket as any).roomId = roomId;

        socket.emit('room:status', {
          status: 'waiting_for_bots',
          room_id: roomId,
          ...stats,
        });
      } catch (err) {
        console.error('Queue error:', err);
        socket.emit('room:error', { message: 'Failed to join queue' });
      }
    });

    // Human sends a chat message
    socket.on('message', async (data: { room_id: string; content: string }) => {
      try {
        const { room_id, content } = data;
        if (!room_id || !content) return;

        const validationError = validateMessageContent(content);
        if (validationError) {
          socket.emit('room:error', { message: validationError });
          return;
        }

        const room = await getRoom(room_id);
        if (!room) {
          socket.emit('room:error', { message: 'Room not found' });
          return;
        }

        if (room.phase !== 'discussion') {
          socket.emit('room:error', { message: 'Not in discussion phase' });
          return;
        }

        if (!room.participants.includes(userId)) {
          socket.emit('room:error', { message: 'Not a participant' });
          return;
        }

        const msg = await addMessage(room_id, userId, content);

        gameNsp.to(`room:${room_id}`).emit('room:message', {
          handle: msg.handle,
          content: msg.content,
          posted_at: msg.postedAt,
        });
      } catch (err) {
        console.error('Message error:', err);
        socket.emit('room:error', { message: 'Failed to send message' });
      }
    });

    socket.on('disconnect', () => {
      // Cleanup handled by room timeout
    });
  });
}
