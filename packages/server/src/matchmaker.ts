import { createRoom, joinRoom, assignHandles, advancePhase, getRoom, getVotes, cleanupRoom } from './rooms.js';
import { computeScores, updateElo } from './scoring.js';
import { db } from './db/connection.js';
import { users, games, gameParticipants } from './db/schema.js';
import { eq } from 'drizzle-orm';
import type { Server } from 'socket.io';
import { postGameResult } from './moltbook.js';

const ROOM_SIZE = 5;
const BOT_COUNT = 4;

// In-memory timers replace BullMQ — simpler, no Redis dependency
const activeTimers = new Map<string, NodeJS.Timeout>();

function clearRoomTimer(key: string): void {
  const timer = activeTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(key);
  }
}

/**
 * Schedule the next phase transition for a room.
 */
function schedulePhaseTransition(roomId: string, delayMs: number, expectedPhase: string, io: Server): void {
  const key = `${roomId}:${expectedPhase}`;
  clearRoomTimer(key);

  const timer = setTimeout(async () => {
    activeTimers.delete(key);
    try {
      await handlePhaseTransition(roomId, expectedPhase, io);
    } catch (err) {
      console.error(`Phase transition failed for room ${roomId}:`, err);
    }
  }, delayMs);

  activeTimers.set(key, timer);
}

async function handlePhaseTransition(roomId: string, expectedPhase: string, io: Server): Promise<void> {
  const room = await getRoom(roomId);
  if (!room) return;

  // Skip if the room has already moved past the expected phase
  if (room.phase !== expectedPhase) return;

  // If still in lobby, check if we have enough players
  if (room.phase === 'lobby') {
    if (room.participants.length >= ROOM_SIZE) {
      await startGame(roomId, io);
    } else {
      io.of('/game').to(`room:${roomId}`).emit('room:error', {
        message: 'Not enough bots joined in time. Please try again.',
      });
      await cleanupRoom(roomId);
    }
    return;
  }

  const newPhase = await advancePhase(roomId);
  const updatedRoom = await getRoom(roomId);

  // Notify all connected clients in the room
  io.of('/game').to(`room:${roomId}`).emit('room:phase', {
    phase: newPhase,
    timerEnd: updatedRoom?.timerEnd,
    topic: newPhase === 'discussion' ? updatedRoom?.topic : undefined,
  });

  // Schedule next transition
  switch (newPhase) {
    case 'discussion':
      schedulePhaseTransition(roomId, 3 * 60_000, 'discussion', io); // 3 min
      break;
    case 'voting':
      schedulePhaseTransition(roomId, 60_000, 'voting', io); // 60s fallback timeout
      break;
    case 'reveal':
      await processGameResults(roomId, io);
      schedulePhaseTransition(roomId, 30_000, 'reveal', io);
      break;
    case 'complete':
      break;
  }
}

/**
 * Called when all bots have voted — skip the timer and advance immediately.
 */
export async function advanceVoting(roomId: string, io: Server): Promise<void> {
  const room = await getRoom(roomId);
  if (!room || room.phase !== 'voting') return;
  clearRoomTimer(`${roomId}:voting`);
  await handlePhaseTransition(roomId, 'voting', io);
}

// Store io reference for use by matchHuman/checkAndStartRoom
let ioRef: Server | null = null;

/**
 * Initialize the phase transition system (replaces BullMQ worker).
 */
export function startPhaseWorker(io: Server): void {
  ioRef = io;
}

/**
 * Create a lobby room for a human. Bots join via REST API polling.
 * Returns roomId immediately. Game starts when enough bots join or after timeout.
 */
export async function matchHuman(humanId: string): Promise<string | null> {
  const roomId = await createRoom(humanId);

  // Schedule a "start anyway" timer — if not enough bots join in 30s, timeout
  if (ioRef) {
    schedulePhaseTransition(roomId, 30_000, 'lobby', ioRef);
  }

  return roomId;
}

/**
 * Called when a bot joins a room. If we have enough participants, start the game.
 */
export async function checkAndStartRoom(roomId: string, io?: any): Promise<void> {
  const room = await getRoom(roomId);
  if (!room || room.phase !== 'lobby') return;

  const participantCount = room.participants.length;

  if (participantCount >= ROOM_SIZE) {
    await startGame(roomId, io);
  }
}

async function startGame(roomId: string, io?: any): Promise<void> {
  // Atomic lock to prevent double-start from concurrent bot joins
  const { getRedis } = await import('./redis.js');
  const redis = getRedis();
  const locked = await redis.set(`room:${roomId}:starting`, '1', 'EX', 10, 'NX');
  if (!locked) return;

  const room = await getRoom(roomId);
  if (!room || room.phase !== 'lobby') return;

  // Clear the lobby timeout
  clearRoomTimer(`${roomId}:lobby`);

  await assignHandles(roomId);
  await advancePhase(roomId); // → topic_reveal

  if (io) {
    schedulePhaseTransition(roomId, 8_000, 'topic_reveal', io); // after 8s → discussion

    const updatedRoom = await getRoom(roomId);
    if (!updatedRoom) return;

    const participants = updatedRoom.participants.map((pid) => ({
      handle: updatedRoom.handleMap[pid],
    }));

    // Send room:joined to each socket with their specific handle
    const sockets = await io.of('/game').in(`room:${roomId}`).fetchSockets();
    for (const sock of sockets) {
      const sockUserId = (sock as any).userId;
      sock.emit('room:joined', {
        room_id: roomId,
        participants,
        your_handle: updatedRoom.handleMap[sockUserId] || participants[0]?.handle,
      });
    }

    io.of('/game').to(`room:${roomId}`).emit('room:phase', {
      phase: updatedRoom.phase,
      timerEnd: updatedRoom.timerEnd,
      topic: updatedRoom.topic,
    });
  }
}

/**
 * Process game results: compute scores, update Elo, persist to Postgres.
 */
async function processGameResults(roomId: string, io: Server): Promise<void> {
  const room = await getRoom(roomId);
  if (!room || !room.humanId) return;

  const votes = await getVotes(roomId);
  // Look up display names for all participants
  const participantUsers = await Promise.all(
    room.participants.map(async (pid) => {
      const [u] = await db.select().from(users).where(eq(users.id, pid));
      return u;
    }),
  );
  const displayNameMap: Record<string, string> = {};
  for (const u of participantUsers) {
    if (u) displayNameMap[u.id] = u.displayName;
  }

  if (votes.size === 0) {
    await db.insert(games).values({
      topic: room.topic,
      humanId: room.humanId,
      humanStealthScore: 1.0,
      roomSize: room.participants.length,
      startedAt: new Date(room.createdAt),
      endedAt: new Date(),
    });
    io.of('/game').to(`room:${roomId}`).emit('room:reveal', {
      results: room.participants.map((pid) => ({
        handle: room.handleMap[pid],
        displayName: displayNameMap[pid] || 'Unknown',
        type: pid === room.humanId ? 'human' : 'bot',
        userId: pid,
        eloChange: 0,
        detectionScore: null,
      })),
      humanStealthScore: 1.0,
    });
    postGameResult({
      topic: room.topic,
      humanHandle: room.handleMap[room.humanId],
      humanStealthScore: 1.0,
      botCount: room.participants.length - 1,
    }).catch(() => {});
    return;
  }

  // Determine human index in participant order
  const participantIds = room.participants;
  const humanIndex = participantIds.indexOf(room.humanId);
  if (humanIndex === -1) return;

  const { humanStealthScore, botResults } = computeScores(votes, humanIndex, participantIds);

  // Calculate average bot Elo for human Elo update
  const botUserIds = botResults.map((r) => r.botUserId);
  const botUsers = await Promise.all(
    botUserIds.map(async (id) => {
      const [user] = await db.select().from(users).where(eq(users.id, id));
      return user;
    }),
  );
  const [humanUser] = await db.select().from(users).where(eq(users.id, room.humanId));

  const avgBotElo = botUsers.reduce((sum, b) => sum + (b?.elo ?? 1200), 0) / botUsers.length;

  // Human wins if stealth > 0.5 (fooled most bots)
  const humanWon = humanStealthScore > 0.5;
  const newHumanElo = updateElo(humanUser.elo, avgBotElo, humanWon ? 1 : 0);

  // Create game record
  const [game] = await db
    .insert(games)
    .values({
      topic: room.topic,
      humanId: room.humanId,
      humanStealthScore,
      roomSize: room.participants.length,
      startedAt: new Date(room.createdAt),
      endedAt: new Date(),
    })
    .returning();

  // Insert participants and update Elo
  // Human participant
  await db.insert(gameParticipants).values({
    gameId: game.id,
    userId: room.humanId,
    role: 'human',
    handle: room.handleMap[room.humanId],
    eloBefore: humanUser.elo,
    eloAfter: newHumanElo,
  });

  await db
    .update(users)
    .set({ elo: newHumanElo, gamesPlayed: humanUser.gamesPlayed + 1 })
    .where(eq(users.id, room.humanId));

  // Bot participants
  const revealResults: Array<{
    handle: string;
    displayName: string;
    type: string;
    userId: string;
    eloChange: number;
    detectionScore: number | null;
  }> = [];

  revealResults.push({
    handle: room.handleMap[room.humanId],
    displayName: displayNameMap[room.humanId] || 'Unknown',
    type: 'human',
    userId: room.humanId,
    eloChange: newHumanElo - humanUser.elo,
    detectionScore: null,
  });

  for (const result of botResults) {
    const botUser = botUsers.find((b) => b?.id === result.botUserId);
    if (!botUser) continue;

    // Bot "wins" if detection score > 1/roomSize (better than random)
    const botWon = result.detectionScore > 1 / ROOM_SIZE;
    const newBotElo = updateElo(botUser.elo, humanUser.elo, botWon ? 1 : 0);

    await db.insert(gameParticipants).values({
      gameId: game.id,
      userId: result.botUserId,
      role: 'bot',
      handle: room.handleMap[result.botUserId],
      rawLogits: result.rawLogits,
      normalizedProbs: result.normalizedProbs,
      detectionScore: result.detectionScore,
      eloBefore: botUser.elo,
      eloAfter: newBotElo,
    });

    await db
      .update(users)
      .set({ elo: newBotElo, gamesPlayed: botUser.gamesPlayed + 1 })
      .where(eq(users.id, result.botUserId));

    revealResults.push({
      handle: room.handleMap[result.botUserId],
      displayName: displayNameMap[result.botUserId] || botUser.displayName,
      type: 'bot',
      userId: result.botUserId,
      eloChange: newBotElo - botUser.elo,
      detectionScore: result.detectionScore,
    });
  }

  // Emit reveal event
  io.of('/game').to(`room:${roomId}`).emit('room:reveal', {
    results: revealResults,
    humanStealthScore,
    gameId: game.id,
  });

  // Post to Moltbook (best-effort, fire and forget)
  const topBot = botResults.reduce((best, r) =>
    r.detectionScore > (best?.detectionScore ?? 0) ? r : best, botResults[0]);
  postGameResult({
    topic: room.topic,
    humanHandle: room.handleMap[room.humanId],
    humanStealthScore,
    botCount: botResults.length,
    topDetector: topBot ? {
      handle: room.handleMap[topBot.botUserId],
      score: topBot.detectionScore,
    } : undefined,
  }).catch(() => {});
}
