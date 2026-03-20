import type { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { matchHuman } from '../matchmaker.js';
import { getRoom, addMessage } from '../rooms.js';
import { getQuickStats } from './stats.js';

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
      const stats = await getQuickStats();
      socket.emit('room:status', { status: 'waiting_for_bots', ...stats });

      const startTime = Date.now();
      let matched = false;

      const tryMatch = async () => {
        if (matched || socket.disconnected) return;

        try {
          const roomId = await matchHuman(userId);
          if (roomId) {
            matched = true;

            socket.join(`room:${roomId}`);
            const room = await getRoom(roomId);
            if (!room) {
              socket.emit('room:error', { message: 'Room creation failed' });
              return;
            }

            const participants = room.participants.map((pid) => ({
              handle: room.handleMap[pid],
            }));

            socket.emit('room:joined', {
              room_id: roomId,
              participants,
              your_handle: room.handleMap[userId],
            });

            socket.emit('room:phase', {
              phase: room.phase,
              timerEnd: room.timerEnd,
              topic: room.topic,
            });
            return;
          }
        } catch (err) {
          console.error('Match attempt error:', err);
        }

        // Check timeout
        if (Date.now() - startTime > MATCH_TIMEOUT) {
          socket.emit('room:error', {
            message: 'No bots available right now. Please try again later.',
          });
          return;
        }

        // Retry with fresh stats
        const currentStats = await getQuickStats();
        socket.emit('room:status', {
          status: 'waiting_for_bots',
          elapsed: Math.floor((Date.now() - startTime) / 1000),
          ...currentStats,
        });
        setTimeout(tryMatch, MATCH_POLL_INTERVAL);
      };

      tryMatch();
    });

    // Human sends a chat message
    socket.on('message', async (data: { room_id: string; content: string }) => {
      try {
        const { room_id, content } = data;
        if (!room_id || !content) return;

        if (content.length > 2000) {
          socket.emit('room:error', { message: 'Message too long' });
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
