import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { agentRoutes } from './routes/agent.js';
import { authRoutes } from './routes/auth.js';
import { leaderboardRoutes } from './routes/leaderboard.js';
import { statsRoutes } from './routes/stats.js';
import { setupWebSocket } from './routes/ws.js';
import { startPhaseWorker } from './matchmaker.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';

async function start() {
  const fastify = Fastify({ logger: true });

  await fastify.register(cors, {
    origin: CORS_ORIGIN,
    credentials: true,
  });

  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Register routes
  await fastify.register(agentRoutes);
  await fastify.register(authRoutes);
  await fastify.register(leaderboardRoutes);
  await fastify.register(statsRoutes);

  // Start HTTP server
  await fastify.listen({ port: PORT, host: '0.0.0.0' });

  // Create Socket.io server
  const io = new Server(fastify.server, {
    cors: {
      origin: CORS_ORIGIN,
      credentials: true,
    },
  });

  // Set up Redis adapter if REDIS_URL is available
  if (process.env.REDIS_URL) {
    const pubClient = new Redis(process.env.REDIS_URL, {
      tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
    });
    const subClient = pubClient.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
    fastify.log.info('Socket.io Redis adapter connected');
  }

  // Decorate fastify with io for use in route handlers
  (fastify as any).io = io;

  // Set up WebSocket handlers
  setupWebSocket(io);

  // Start BullMQ phase worker
  if (process.env.REDIS_URL) {
    startPhaseWorker(io);
    fastify.log.info('Phase transition worker started');
  }

  fastify.log.info(`Server listening on port ${PORT}`);
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
