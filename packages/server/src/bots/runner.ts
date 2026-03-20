import 'dotenv/config';
import { PERSONALITIES, type BotPersonality, type LLMProvider } from './personalities.js';
import * as gemini from './gemini.js';
import { llama, qwen } from './groq.js';

function getLLM(provider: LLMProvider) {
  switch (provider) {
    case 'groq': return llama;
    case 'groq-qwen': return qwen;
    case 'gemini': return gemini;
  }
}

const API_BASE = process.env.BOT_API_BASE || 'http://localhost:3001';

interface BotState {
  personality: BotPersonality;
  userId: string;
  apiKey: string;
  currentRoom: string | null;
  currentTopic: string | null;
  messagesSent: number;
  lastMessageTime: number;
}

function headers(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

async function api(path: string, apiKey: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: headers(apiKey),
    ...options,
  });
  return res.json();
}

async function registerBot(personality: BotPersonality): Promise<{ userId: string; apiKey: string }> {
  const data = await api('/agents/register', '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      openclaw_uuid: `builtin-${personality.name}`,
      display_name: personality.displayName,
    }),
  });
  console.log(`[${personality.name}] Registered as ${data.user_id}`);
  return { userId: data.user_id, apiKey: data.api_key };
}

async function botLoop(bot: BotState): Promise<void> {
  const { personality, apiKey } = bot;
  const tag = `[${personality.name}]`;

  console.log(`${tag} Starting poll loop`);

  while (true) {
    try {
      if (!bot.currentRoom) {
        // Check for available rooms
        const rooms = await api('/agents/rooms/available', apiKey);
        if (Array.isArray(rooms) && rooms.length > 0) {
          const room = rooms[0];
          console.log(`${tag} Found room ${room.room_id} (${room.slots_remaining} slots)`);
          const joinResult = await api(`/agents/rooms/${room.room_id}/join`, apiKey, {
            method: 'POST',
            body: '{}',
          });
          if (joinResult.joined) {
            bot.currentRoom = room.room_id;
            bot.currentTopic = joinResult.topic || room.topic;
            bot.messagesSent = 0;
            console.log(`${tag} Joined room ${room.room_id} — topic: "${bot.currentTopic}"`);
          } else {
            console.log(`${tag} Failed to join: ${joinResult.error || 'unknown'}`);
          }
        } else if (rooms.error) {
          console.log(`${tag} Poll error: ${rooms.error}`);
        }
        await sleep(5000);
        continue;
      }

      // We're in a room — fetch messages and participate
      const messages = await api(
        `/agents/rooms/${bot.currentRoom}/messages`,
        apiKey,
      );

      if (messages.error) {
        // Room might be gone
        console.log(`${tag} Room ended or error: ${messages.error}`);
        bot.currentRoom = null;
        bot.currentTopic = null;
        continue;
      }

      // During discussion: post messages with 10s base + random jitter
      const now = Date.now();
      const cooldown = 4000 + Math.floor(Math.random() * 5000); // 4-9s between messages
      if (
        bot.messagesSent < 5 &&
        now - bot.lastMessageTime > cooldown
      ) {
        try {
          const chatHistory = (messages as any[]).map((m: any) => ({
            role: m.handle === personality.displayName ? 'assistant' : 'user',
            content: `${m.handle}: ${m.content}`,
          }));

          const topic = bot.currentTopic || 'a general topic';
          const topicContext = chatHistory.length > 0
            ? `The topic is: "${topic}"\n\nRecent messages:\n${chatHistory.slice(-10).map((m: any) => m.content).join('\n')}\n\nContribute to the conversation naturally. Stay on topic.`
            : `The topic is: "${topic}"\n\nThe discussion has just started. Share your initial thoughts.`;

          const llm = getLLM(personality.provider);
          const response = await llm.chatCompletion(personality.chatStyle, [
            { role: 'user', content: topicContext },
          ]);

          if (response && response.length > 0 && response.length <= 500) {
            const postResult = await api(`/agents/rooms/${bot.currentRoom}/message`, apiKey, {
              method: 'POST',
              body: JSON.stringify({ content: response }),
            });

            if (postResult.message_id) {
              bot.messagesSent++;
              bot.lastMessageTime = now;
              console.log(`${tag} Sent message ${bot.messagesSent}/5: "${response.substring(0, 60)}..."`);
            }
          }
        } catch (err: any) {
          console.error(`${tag} Chat error:`, err.message || err);
          // If room moved to voting, try voting
          if (err.message?.includes('not in discussion') || err.message?.includes('voting')) {
            await tryVote(bot, messages);
          }
        }
      }

      await sleep(2000 + Math.floor(Math.random() * 3000)); // 2-5s poll interval
    } catch (err: any) {
      if (err.message?.includes('Not in discussion') || err.message?.includes('voting')) {
        await tryVote(bot, []);
      }
      console.error(`${tag} Error:`, err.message || err);
      await sleep(3000);
    }
  }
}

async function tryVote(bot: BotState, messages: any[]): Promise<void> {
  if (!bot.currentRoom) return;
  const tag = `[${bot.personality.name}]`;

  try {
    // Fetch all messages for voting analysis
    const allMessages = await api(`/agents/rooms/${bot.currentRoom}/messages`, bot.apiKey);
    if (allMessages.error) {
      bot.currentRoom = null;
      return;
    }

    const msgList = allMessages as any[];
    const handles = [...new Set(msgList.map((m: any) => m.handle))] as string[];

    if (handles.length === 0) {
      bot.currentRoom = null;
      return;
    }

    const conversationSummary = msgList
      .map((m: any) => `${m.handle}: ${m.content}`)
      .join('\n');

    const llm = getLLM(bot.personality.provider);
    const logits = await llm.generateLogits(
      bot.personality.votePrompt,
      conversationSummary,
      handles,
    );

    const voteResult = await api(`/agents/rooms/${bot.currentRoom}/vote`, bot.apiKey, {
      method: 'POST',
      body: JSON.stringify({ logits }),
    });

    if (voteResult.received) {
      console.log(`${tag} Voted: ${logits.map((l) => l.toFixed(2)).join(', ')}`);
    }

    // Game over for this room
    bot.currentRoom = null;
  } catch {
    // Not in voting phase yet, or already voted
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('Starting bot runner with 5 personalities...');
  console.log(`API base: ${API_BASE}`);

  const bots: BotState[] = [];

  for (const personality of PERSONALITIES) {
    const { userId, apiKey } = await registerBot(personality);
    bots.push({
      personality,
      userId,
      apiKey,
      currentRoom: null,
      currentTopic: null,
      messagesSent: 0,
      lastMessageTime: 0,
    });
  }

  console.log(`All ${bots.length} bots registered. Starting game loops...`);

  // Run all bot loops concurrently
  await Promise.all(bots.map((bot) => botLoop(bot)));
}

main().catch((err) => {
  console.error('Bot runner failed:', err);
  process.exit(1);
});
