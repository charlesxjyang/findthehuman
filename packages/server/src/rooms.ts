import { getRedis } from './redis.js';
import { getRandomTopic } from './topics.js';
import { randomUUID, randomBytes } from 'node:crypto';

function nanoid(size: number = 12): string {
  return randomBytes(size).toString('base64url').slice(0, size);
}

export type RoomPhase =
  | 'lobby'
  | 'topic_reveal'
  | 'discussion'
  | 'voting'
  | 'reveal'
  | 'complete';

export interface RoomState {
  id: string;
  phase: RoomPhase;
  topic: string;
  humanId: string | null;
  createdAt: string;
  timerEnd: string | null;
  participants: string[];
  handleMap: Record<string, string>; // userId → "Player N"
}

export interface RoomMessage {
  id: string;
  userId: string;
  handle: string;
  content: string;
  postedAt: string;
}

const HANDLE_COLORS = ['Red', 'Blue', 'Green', 'Purple', 'Orange', 'Teal'];
const HANDLE_ANIMALS = ['Fox', 'Owl', 'Wolf', 'Lynx', 'Crow', 'Hare', 'Moth', 'Wren', 'Deer', 'Newt'];

function generateHandles(count: number): string[] {
  const animals = shuffleArray(HANDLE_ANIMALS).slice(0, count);
  const colors = shuffleArray(HANDLE_COLORS).slice(0, count);
  return colors.map((c, i) => `${c} ${animals[i]}`);
}

function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export async function createRoom(humanId: string): Promise<string> {
  const redis = getRedis();
  const roomId = nanoid(12);
  const topic = getRandomTopic();

  const ROOM_TTL = 600; // 10 minutes — must outlast full game (lobby + 10s + 3min + 60s + reveal)

  await redis.hset(`room:${roomId}`, {
    phase: 'lobby',
    topic,
    humanId,
    createdAt: new Date().toISOString(),
    timerEnd: '',
  });
  await redis.expire(`room:${roomId}`, ROOM_TTL);

  // Add human as first participant
  await redis.sadd(`room:${roomId}:participants`, humanId);
  await redis.expire(`room:${roomId}:participants`, ROOM_TTL);
  await redis.expire(`room:${roomId}:messages`, ROOM_TTL);
  await redis.expire(`room:${roomId}:votes`, ROOM_TTL);

  return roomId;
}

export async function joinRoom(roomId: string, userId: string): Promise<{ joined: boolean; participantCount: number }> {
  const redis = getRedis();

  const phase = await redis.hget(`room:${roomId}`, 'phase');
  if (phase !== 'lobby') {
    return { joined: false, participantCount: 0 };
  }

  await redis.sadd(`room:${roomId}:participants`, userId);
  const count = await redis.scard(`room:${roomId}:participants`);

  return { joined: true, participantCount: count };
}

export async function assignHandles(roomId: string): Promise<Record<string, string>> {
  const redis = getRedis();
  const participants = await redis.smembers(`room:${roomId}:participants`);
  const shuffled = shuffleArray(participants);

  const handles = generateHandles(shuffled.length);
  const handleMap: Record<string, string> = {};
  shuffled.forEach((userId, i) => {
    handleMap[userId] = handles[i];
  });

  await redis.hset(`room:${roomId}`, 'handleMap', JSON.stringify(handleMap));
  return handleMap;
}

export async function advancePhase(roomId: string): Promise<RoomPhase> {
  const redis = getRedis();
  const currentPhase = (await redis.hget(`room:${roomId}`, 'phase')) as RoomPhase;

  const transitions: Record<RoomPhase, RoomPhase> = {
    lobby: 'topic_reveal',
    topic_reveal: 'discussion',
    discussion: 'voting',
    voting: 'reveal',
    reveal: 'complete',
    complete: 'complete',
  };

  const nextPhase = transitions[currentPhase];
  const now = new Date();
  let timerEnd = '';

  switch (nextPhase) {
    case 'topic_reveal':
      timerEnd = new Date(now.getTime() + 10_000).toISOString(); // 10 sec
      break;
    case 'discussion':
      timerEnd = new Date(now.getTime() + 3 * 60_000).toISOString(); // 3 min
      break;
    case 'voting':
      timerEnd = new Date(now.getTime() + 25_000).toISOString(); // 25 sec
      break;
  }

  await redis.hset(`room:${roomId}`, { phase: nextPhase, timerEnd });
  return nextPhase;
}

export async function getRoom(roomId: string): Promise<RoomState | null> {
  const redis = getRedis();
  const data = await redis.hgetall(`room:${roomId}`);

  if (!data.phase) return null;

  const participants = await redis.smembers(`room:${roomId}:participants`);
  const handleMap = data.handleMap ? JSON.parse(data.handleMap) : {};

  return {
    id: roomId,
    phase: data.phase as RoomPhase,
    topic: data.topic,
    humanId: data.humanId || null,
    createdAt: data.createdAt,
    timerEnd: data.timerEnd || null,
    participants,
    handleMap,
  };
}

export async function addMessage(
  roomId: string,
  userId: string,
  content: string,
): Promise<RoomMessage> {
  const redis = getRedis();
  const room = await getRoom(roomId);
  if (!room) throw new Error('Room not found');

  const handle = room.handleMap[userId] || 'Unknown';
  const msg: RoomMessage = {
    id: nanoid(8),
    userId,
    handle,
    content,
    postedAt: new Date().toISOString(),
  };

  await redis.rpush(`room:${roomId}:messages`, JSON.stringify(msg));
  return msg;
}

export async function getMessages(roomId: string, since?: string): Promise<RoomMessage[]> {
  const redis = getRedis();
  const raw = await redis.lrange(`room:${roomId}:messages`, 0, -1);
  const messages = raw.map((r) => JSON.parse(r) as RoomMessage);

  if (since) {
    const sinceDate = new Date(since).getTime();
    return messages.filter((m) => new Date(m.postedAt).getTime() > sinceDate);
  }

  return messages;
}

export async function submitVote(
  roomId: string,
  botUserId: string,
  logits: number[],
): Promise<void> {
  const redis = getRedis();
  await redis.hset(`room:${roomId}:votes`, botUserId, JSON.stringify(logits));
}

export async function getVotes(roomId: string): Promise<Map<string, number[]>> {
  const redis = getRedis();
  const raw = await redis.hgetall(`room:${roomId}:votes`);
  const votes = new Map<string, number[]>();
  for (const [botId, logitsJson] of Object.entries(raw)) {
    votes.set(botId, JSON.parse(logitsJson));
  }
  return votes;
}

export async function cleanupRoom(roomId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(
    `room:${roomId}`,
    `room:${roomId}:participants`,
    `room:${roomId}:messages`,
    `room:${roomId}:votes`,
  );
}
