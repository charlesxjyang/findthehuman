import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { getRedis } from './redis.js';
import { createRoom, joinRoom, assignHandles, advancePhase, getRoom, getVotes } from './rooms.js';
import { computeScores, updateElo } from './scoring.js';
import { db } from './db/connection.js';
import { users, games, gameParticipants } from './db/schema.js';
import { eq } from 'drizzle-orm';
import type { Server } from 'socket.io';

function getRedisConnection(): ConnectionOptions {
  return getRedis() as unknown as ConnectionOptions;
}

const ROOM_SIZE = 6;
const BOT_COUNT = 5;

let phaseQueue: Queue | null = null;
let phaseWorker: Worker | null = null;

export function getPhaseQueue(): Queue {
  if (!phaseQueue) {
    phaseQueue = new Queue('phase-transitions', {
      connection: getRedisConnection(),
    });
  }
  return phaseQueue;
}

/**
 * Schedule the next phase transition for a room.
 */
export async function schedulePhaseTransition(roomId: string, delayMs: number): Promise<void> {
  const queue = getPhaseQueue();
  await queue.add(
    'advance',
    { roomId },
    { delay: delayMs, removeOnComplete: true, removeOnFail: 100 },
  );
}

/**
 * Try to match a human with available bots and start a game.
 * Returns roomId if successful, null if not enough bots available.
 */
export async function matchHuman(humanId: string): Promise<string | null> {
  // Find available bots from the database
  const availableBots = await db
    .select()
    .from(users)
    .where(eq(users.type, 'bot'))
    .limit(BOT_COUNT);

  // Start with however many bots are available (0 is fine for testing)
  const shuffled = [...availableBots].sort(() => Math.random() - 0.5);
  const selectedBots = shuffled.slice(0, BOT_COUNT);

  // Create room
  const roomId = await createRoom(humanId);

  // Bots join the room
  for (const bot of selectedBots) {
    await joinRoom(roomId, bot.id);
  }

  // Assign random handles
  await assignHandles(roomId);

  // Transition to topic_reveal and schedule timers
  await advancePhase(roomId); // → topic_reveal
  await schedulePhaseTransition(roomId, 10_000); // after 10s → discussion

  return roomId;
}

/**
 * Start the BullMQ worker that processes phase transitions.
 */
export function startPhaseWorker(io: Server): void {
  phaseWorker = new Worker(
    'phase-transitions',
    async (job) => {
      const { roomId } = job.data;
      const room = await getRoom(roomId);
      if (!room) return;

      const newPhase = await advancePhase(roomId);
      const updatedRoom = await getRoom(roomId);

      // Notify all connected clients in the room
      io.to(`room:${roomId}`).emit('room:phase', {
        phase: newPhase,
        timerEnd: updatedRoom?.timerEnd,
        topic: newPhase === 'discussion' ? updatedRoom?.topic : undefined,
      });

      // Schedule next transition
      switch (newPhase) {
        case 'discussion':
          await schedulePhaseTransition(roomId, 5 * 60_000); // 5 min
          break;
        case 'voting':
          await schedulePhaseTransition(roomId, 60_000); // 60 sec
          break;
        case 'reveal':
          // Process scores and write to DB
          await processGameResults(roomId, io);
          // Auto-advance to complete after 30 seconds
          await schedulePhaseTransition(roomId, 30_000);
          break;
        case 'complete':
          // Cleanup Redis state after a delay
          // Room data is persisted in Postgres
          break;
      }
    },
    { connection: getRedisConnection() },
  );

  phaseWorker.on('failed', (job, err) => {
    console.error(`Phase transition job ${job?.id} failed:`, err);
  });
}

/**
 * Process game results: compute scores, update Elo, persist to Postgres.
 */
async function processGameResults(roomId: string, io: Server): Promise<void> {
  const room = await getRoom(roomId);
  if (!room || !room.humanId) return;

  const votes = await getVotes(roomId);
  // If no bots voted (e.g. solo testing), skip scoring but still record the game
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
        type: pid === room.humanId ? 'human' : 'bot',
        userId: pid,
        eloChange: 0,
        detectionScore: null,
      })),
      humanStealthScore: 1.0,
    });
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
    type: string;
    userId: string;
    eloChange: number;
    detectionScore: number | null;
  }> = [];

  revealResults.push({
    handle: room.handleMap[room.humanId],
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
      type: 'bot',
      userId: result.botUserId,
      eloChange: newBotElo - botUser.elo,
      detectionScore: result.detectionScore,
    });
  }

  // Emit reveal event
  io.to(`room:${roomId}`).emit('room:reveal', {
    results: revealResults,
    humanStealthScore,
    gameId: game.id,
  });
}
