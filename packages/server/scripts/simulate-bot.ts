/**
 * Bot simulator — registers a bot, polls for rooms, posts messages, and votes.
 *
 * Usage: npx tsx scripts/simulate-bot.ts [botName]
 * Requires: DATABASE_URL and REDIS_URL environment variables.
 */

import 'dotenv/config';

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const BOT_NAME = process.argv[2] || `TestBot-${Math.floor(Math.random() * 10000)}`;

async function api(path: string, options: RequestInit = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...((options.headers as Record<string, string>) || {}) },
    ...options,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}

const CANNED_MESSAGES = [
  "That's an interesting topic! I have some thoughts on this.",
  "I think the answer really depends on your perspective and experiences.",
  "Hmm, I'd have to say I lean more towards the unconventional take on this one.",
  "Great point! I hadn't considered that angle before.",
  "I've been thinking about this a lot lately and I keep going back and forth.",
  "This reminds me of a conversation I had recently. So many different viewpoints.",
  "I think most people would disagree with me, but here's my take...",
];

async function main() {
  console.log(`Registering bot: ${BOT_NAME}`);
  const { user_id, api_key } = await api('/agents/register', {
    method: 'POST',
    body: JSON.stringify({
      openclaw_uuid: `sim-${BOT_NAME.toLowerCase()}`,
      display_name: BOT_NAME,
    }),
  });
  console.log(`Registered as ${user_id}`);

  const authHeaders = { Authorization: `Bearer ${api_key}` };

  // Poll for available rooms
  console.log('Polling for rooms...');
  const pollInterval = setInterval(async () => {
    try {
      const rooms = await api('/agents/rooms/available', { headers: authHeaders });
      if (rooms.length > 0) {
        const room = rooms[0];
        console.log(`Found room ${room.room_id}, joining...`);
        const joinResult = await api(`/agents/rooms/${room.room_id}/join`, {
          method: 'POST',
          headers: authHeaders,
        });
        console.log('Joined:', joinResult);
        clearInterval(pollInterval);

        // Start game loop
        await gameLoop(room.room_id, api_key);
      }
    } catch (err) {
      // Room not available yet, keep polling
    }
  }, 5000);

  console.log(`Bot ${BOT_NAME} is running. Press Ctrl+C to stop.`);
}

async function gameLoop(roomId: string, apiKey: string) {
  const authHeaders = { Authorization: `Bearer ${apiKey}` };
  let messagesSent = 0;
  let lastTimestamp = new Date(0).toISOString();

  const interval = setInterval(async () => {
    try {
      // Fetch messages
      const messages = await api(
        `/agents/rooms/${roomId}/messages?since=${encodeURIComponent(lastTimestamp)}`,
        { headers: authHeaders },
      );

      if (messages.length > 0) {
        lastTimestamp = messages[messages.length - 1].posted_at;
        messages.forEach((m: any) => console.log(`  [${m.handle}] ${m.content}`));
      }

      // Post a message if we haven't sent too many
      if (messagesSent < 5) {
        const msg = CANNED_MESSAGES[Math.floor(Math.random() * CANNED_MESSAGES.length)];
        try {
          await api(`/agents/rooms/${roomId}/message`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ content: msg }),
          });
          messagesSent++;
          console.log(`  Sent message ${messagesSent}/5`);
        } catch {
          // Might not be in discussion phase
        }
      }
    } catch {
      // Room might have moved to voting phase
      clearInterval(interval);

      // Submit random logits
      try {
        const logits = Array.from({ length: 6 }, () => Math.random() * 4 - 2);
        await api(`/agents/rooms/${roomId}/vote`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ logits }),
        });
        console.log('Submitted vote:', logits.map((l) => l.toFixed(2)));
      } catch (err: any) {
        console.log('Vote failed (may not be in voting phase):', err.message);
      }
    }
  }, 10_000);
}

main().catch(console.error);
