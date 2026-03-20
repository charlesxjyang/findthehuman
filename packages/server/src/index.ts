import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';

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

  // Create HTTP server first, then attach Socket.io
  await fastify.listen({ port: PORT, host: '0.0.0.0' });

  const io = new Server(fastify.server, {
    cors: {
      origin: CORS_ORIGIN,
      credentials: true,
    },
  });

  // Set up Redis adapter if REDIS_URL is available
  if (process.env.REDIS_URL) {
    const pubClient = new Redis(process.env.REDIS_URL);
    const subClient = pubClient.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
    fastify.log.info('Socket.io Redis adapter connected');
  }

  // Attach io to fastify for use in routes
  fastify.decorate('io', io);

  fastify.log.info(`Server listening on port ${PORT}`);
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
