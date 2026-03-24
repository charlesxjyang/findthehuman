import 'dotenv/config';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { Server } from 'socket.io';
import { agentRoutes } from './routes/agent.js';
import { authRoutes } from './routes/auth.js';
import { leaderboardRoutes } from './routes/leaderboard.js';
import { statsRoutes } from './routes/stats.js';
import { setupWebSocket } from './routes/ws.js';
import { startPhaseWorker } from './matchmaker.js';
import { ensureSubmolt } from './moltbook.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

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

  // Register API routes
  await fastify.register(agentRoutes);
  await fastify.register(authRoutes);
  await fastify.register(leaderboardRoutes);
  await fastify.register(statsRoutes);

  // Serve Next.js static export
  const webOutDir = resolve(__dirname, '../../web/out');
  if (existsSync(webOutDir)) {
    await fastify.register(fastifyStatic, {
      root: webOutDir,
      prefix: '/',
      wildcard: false,
    });

    // SPA fallback — serve index.html for unmatched routes (client-side routing)
    const indexHtml = readFileSync(join(webOutDir, 'index.html'), 'utf-8');
    fastify.setNotFoundHandler((request, reply) => {
      // Return JSON 404 for API-like requests
      const accept = request.headers.accept || '';
      if (
        request.url.startsWith('/agents/') ||
        request.url.startsWith('/auth/') ||
        request.url.startsWith('/leaderboard') ||
        request.url.startsWith('/stats') ||
        request.url.startsWith('/health') ||
        !accept.includes('text/html')
      ) {
        reply.code(404).send({ error: 'Not found' });
        return;
      }
      reply.code(200).type('text/html').send(indexHtml);
    });

    fastify.log.info(`Serving frontend from ${webOutDir}`);
  } else {
    fastify.log.warn(`Frontend build not found at ${webOutDir} — API-only mode`);
  }

  // Start HTTP server
  await fastify.listen({ port: PORT, host: '0.0.0.0' });

  // Create Socket.io server
  const io = new Server(fastify.server, {
    cors: {
      origin: CORS_ORIGIN,
      credentials: true,
    },
  });

  // Socket.io Redis adapter removed — not needed for single-instance deployment
  // and was causing silent broadcast failures after Redis flush

  // Decorate fastify with io for use in route handlers
  (fastify as any).io = io;

  // Set up WebSocket handlers
  setupWebSocket(io);

  // Initialize phase transition system
  startPhaseWorker(io);
  fastify.log.info('Phase transition system started');

  // Create Moltbook submolt (best-effort)
  if (process.env.MOLTBOOK_API_KEY) {
    ensureSubmolt().catch(() => {});
    fastify.log.info('Moltbook integration enabled');
  }

  fastify.log.info(`Server listening on port ${PORT}`);
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
