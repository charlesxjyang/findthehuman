import type { FastifyInstance } from 'fastify';
import { db } from '../db/connection.js';
import { users } from '../db/schema.js';
import { eq, or } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

function issueToken(userId: string): string {
  return jwt.sign({ userId, type: 'human' }, JWT_SECRET, { expiresIn: '7d' });
}

function issueAnonToken(userId: string): string {
  return jwt.sign({ userId, type: 'human' }, JWT_SECRET, { expiresIn: '24h' });
}

// GitHub-style random display names for anonymous users
const ADJECTIVES = [
  'fluffy', 'scaling', 'turbo', 'fuzzy', 'glowing', 'organic', 'sturdy',
  'curly', 'shiny', 'humble', 'zesty', 'literate', 'upgraded', 'bookish',
  'verbose', 'miniature', 'probable', 'fictional', 'symmetrical', 'animated',
];
const NOUNS = [
  'pancake', 'barnacle', 'umbrella', 'telegram', 'waffle', 'doodle',
  'parakeet', 'invention', 'adventure', 'sniffle', 'chainmail', 'broccoli',
  'eureka', 'fishstick', 'guacamole', 'mnemonic', 'spork', 'potato',
  'tribble', 'octopus',
];

function randomDisplayName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 9000) + 1000;
  return `${adj}-${noun}-${num}`;
}

export async function authRoutes(fastify: FastifyInstance) {
  // --- GitHub OAuth ---
  fastify.get('/auth/github', async (_request, reply) => {
    const state = randomBytes(16).toString('hex');
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: `${getServerUrl()}/auth/github/callback`,
      scope: 'read:user user:email',
      state,
    });
    return reply.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  fastify.get('/auth/github/callback', async (request, reply) => {
    const { code } = request.query as { code?: string };
    if (!code) {
      return reply.redirect(`${FRONTEND_URL}/auth/callback?error=missing_code`);
    }

    try {
      // Exchange code for token
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code,
        }),
      });
      const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
      if (!tokenData.access_token) {
        return reply.redirect(`${FRONTEND_URL}/auth/callback?error=token_exchange_failed`);
      }

      // Fetch user profile
      const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const ghUser = await userRes.json() as { id: number; login: string; email?: string };

      const githubId = String(ghUser.id);

      // Find or create user
      let [user] = await db.select().from(users).where(eq(users.githubId, githubId));

      if (!user && ghUser.email) {
        // Try to link by email (existing magic-code user migrating to OAuth)
        [user] = await db.select().from(users).where(eq(users.email, ghUser.email));
        if (user) {
          await db.update(users).set({ githubId }).where(eq(users.id, user.id));
        }
      }

      if (!user) {
        [user] = await db
          .insert(users)
          .values({
            type: 'human',
            displayName: ghUser.login,
            email: ghUser.email || null,
            githubId,
          })
          .returning();
      }

      const token = issueToken(user.id);
      return reply.redirect(`${FRONTEND_URL}/auth/callback?token=${token}`);
    } catch (err) {
      fastify.log.error(err, 'GitHub OAuth error');
      return reply.redirect(`${FRONTEND_URL}/auth/callback?error=oauth_failed`);
    }
  });

  // --- Google OAuth ---
  fastify.get('/auth/google', async (_request, reply) => {
    const state = randomBytes(16).toString('hex');
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: `${getServerUrl()}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
    });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  fastify.get('/auth/google/callback', async (request, reply) => {
    const { code } = request.query as { code?: string };
    if (!code) {
      return reply.redirect(`${FRONTEND_URL}/auth/callback?error=missing_code`);
    }

    try {
      // Exchange code for token
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: `${getServerUrl()}/auth/google/callback`,
          grant_type: 'authorization_code',
        }),
      });
      const tokenData = await tokenRes.json() as { access_token?: string };
      if (!tokenData.access_token) {
        return reply.redirect(`${FRONTEND_URL}/auth/callback?error=token_exchange_failed`);
      }

      // Fetch user info
      const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const gUser = await userRes.json() as { sub: string; name?: string; email?: string };

      const googleId = gUser.sub;

      // Find or create user
      let [user] = await db.select().from(users).where(eq(users.googleId, googleId));

      if (!user && gUser.email) {
        [user] = await db.select().from(users).where(eq(users.email, gUser.email));
        if (user) {
          await db.update(users).set({ googleId }).where(eq(users.id, user.id));
        }
      }

      if (!user) {
        [user] = await db
          .insert(users)
          .values({
            type: 'human',
            displayName: gUser.name || gUser.email?.split('@')[0] || 'Player',
            email: gUser.email || null,
            googleId,
          })
          .returning();
      }

      const token = issueToken(user.id);
      return reply.redirect(`${FRONTEND_URL}/auth/callback?token=${token}`);
    } catch (err) {
      fastify.log.error(err, 'Google OAuth error');
      return reply.redirect(`${FRONTEND_URL}/auth/callback?error=oauth_failed`);
    }
  });

  // --- Anonymous play ---
  fastify.post('/auth/anonymous', async () => {
    const [user] = await db
      .insert(users)
      .values({
        type: 'human',
        displayName: randomDisplayName(),
      })
      .returning();

    const token = issueAnonToken(user.id);
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

  // --- Get current user from token ---
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

function getServerUrl(): string {
  // Railway provides RAILWAY_PUBLIC_DOMAIN
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  return `http://localhost:${process.env.PORT || 3001}`;
}
