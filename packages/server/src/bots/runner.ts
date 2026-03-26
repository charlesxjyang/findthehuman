import 'dotenv/config';
import { PERSONALITIES, type BotPersonality, type LLMProvider } from './personalities.js';
import * as gemini from './gemini.js';
import { llama, qwen, compound } from './groq.js';

function getLLM(provider: LLMProvider) {
  switch (provider) {
    case 'groq': return llama;
    case 'groq-qwen': return qwen;
    case 'groq-compound': return compound;
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
  currentHandle: string | null;
  messagesSent: number;
  lastMessageTime: number;
  roomJoinedAt: number;
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

  // Stagger bot start times so different bots join different games
  const startDelay = Math.floor(Math.random() * 4000);
  console.log(`${tag} Starting poll loop (delay ${startDelay}ms)`);
  await sleep(startDelay);

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
            bot.roomJoinedAt = Date.now();
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

      // We're in a room — check phase first
      const roomState = await api(`/agents/rooms/${bot.currentRoom}/status`, apiKey);

      // Track our handle once assigned
      if (roomState.your_handle && !bot.currentHandle) {
        bot.currentHandle = roomState.your_handle;
        console.log(`${tag} Handle assigned: ${bot.currentHandle}`);
      }

      if (roomState.error || roomState.phase === 'reveal' || roomState.phase === 'complete') {
        console.log(`${tag} Room ended (phase: ${roomState.phase || 'error'})`);
        bot.currentRoom = null;
        bot.currentTopic = null;
        bot.currentHandle = null;
        bot.currentHandle = null;
        continue;
      }

      if (roomState.phase === 'lobby') {
        // Still waiting for game to start — bail after 35s to avoid getting trapped
        if (Date.now() - bot.roomJoinedAt > 35_000) {
          console.log(`${tag} Room ${bot.currentRoom} stuck in lobby, leaving`);
          bot.currentRoom = null;
          bot.currentTopic = null;
          continue;
        }
        await sleep(2000);
        continue;
      }

      if (roomState.phase === 'voting') {
        await tryVote(bot);
        continue;
      }

      if (roomState.phase === 'topic_reveal') {
        await sleep(2000);
        continue;
      }

      // discussion phase — fetch messages and participate
      const messages = await api(
        `/agents/rooms/${bot.currentRoom}/messages`,
        apiKey,
      );

      if (messages.error) {
        console.log(`${tag} Messages error: ${messages.error}`);
        bot.currentRoom = null;
        bot.currentTopic = null;
        bot.currentHandle = null;
        continue;
      }

      const now = Date.now();
      const msgList = messages as any[];

      // Simulate reading time: ~20 chars/sec for new messages since last check
      const newMsgs = msgList.filter((m: any) =>
        new Date(m.posted_at).getTime() > bot.lastMessageTime
      );
      const newChars = newMsgs.reduce((sum: number, m: any) => sum + m.content.length, 0);
      const readTimeMs = Math.min((newChars / 20) * 1000, 5000); // cap at 5s

      if (readTimeMs > 500) {
        await sleep(readTimeMs);
      }

      if (bot.messagesSent < 22) {
        try {
          const ownHandle = bot.currentHandle;
          const chatHistory = msgList.map((m: any) => ({
            role: m.handle === ownHandle ? 'assistant' : 'user',
            content: `${m.handle}: ${m.content}`,
          }));

          const topic = bot.currentTopic || 'a general topic';
          const recentMsgs = chatHistory.slice(-8).map((m: any) => m.content).join('\n');
          const selfNote = ownHandle ? ` Your name in the chat is "${ownHandle}" — do NOT reply to yourself or reference your own messages.` : '';
          const topicContext = chatHistory.length > 0
            ? `You're in a group chat discussing: "${topic}".${selfNote}\n\nRecent messages:\n${recentMsgs}\n\nREPLY to the most recent message or react to what someone specific said. Use their name. Agree, disagree, ask them a question, or build on their point. Do NOT just state your own opinion in isolation. Be conversational like a real group chat.`
            : `You just joined a group chat. The topic is: "${topic}".${selfNote}\n\nYou're the first to speak. Share a brief opening thought or question to kick off the conversation.`;

          const llm = getLLM(personality.provider);
          const response = await llm.chatCompletion(personality.chatStyle, [
            { role: 'user', content: topicContext },
          ]);

          if (response && response.length > 0 && response.length <= 500) {
            // Simulate typing time: ~12 chars/sec + random jitter
            const typeTimeMs = (response.length / 12) * 1000 + Math.random() * 2000;
            await sleep(typeTimeMs);

            const postResult = await api(`/agents/rooms/${bot.currentRoom}/message`, apiKey, {
              method: 'POST',
              body: JSON.stringify({ content: response }),
            });

            if (postResult.message_id) {
              bot.messagesSent++;
              bot.lastMessageTime = Date.now();
              console.log(`${tag} Sent message ${bot.messagesSent}: "${response.substring(0, 60)}..."`);
            }
          }
        } catch (err: any) {
          console.error(`${tag} Chat error:`, err.message || err);
          if (err.message?.includes('not in discussion') || err.message?.includes('voting')) {
            await tryVote(bot);
          }
        }
      }

      await sleep(2000 + Math.floor(Math.random() * 3000)); // 2-5s poll interval
    } catch (err: any) {
      console.error(`${tag} Error:`, err.message || err);
      await sleep(3000);
    }
  }
}

async function tryVote(bot: BotState): Promise<void> {
  if (!bot.currentRoom) return;
  const tag = `[${bot.personality.name}]`;

  try {
    // Get all messages for analysis
    const allMessages = await api(`/agents/rooms/${bot.currentRoom}/messages`, bot.apiKey);
    const msgList = Array.isArray(allMessages) ? allMessages : [];

    // Build conversation summary
    const handles = [...new Set(msgList.map((m: any) => m.handle))] as string[];
    const conversationSummary = msgList
      .map((m: any) => `${m.handle}: ${m.content}`)
      .join('\n');

    if (handles.length === 0) {
      // No messages — submit random logits
      const logits = Array.from({ length: 5 }, () => Math.random() * 4 - 2);
      await api(`/agents/rooms/${bot.currentRoom}/vote`, bot.apiKey, {
        method: 'POST',
        body: JSON.stringify({ logits }),
      });
    } else {
      const llm = getLLM(bot.personality.provider);
      const logits = await llm.generateLogits(
        bot.personality.votePrompt,
        conversationSummary,
        handles,
        bot.currentHandle,
      );

      // Pad or trim logits to match room size (5 participants)
      while (logits.length < 5) logits.push(Math.random() * 2 - 1);
      const trimmed = logits.slice(0, 5);

      const voteResult = await api(`/agents/rooms/${bot.currentRoom}/vote`, bot.apiKey, {
        method: 'POST',
        body: JSON.stringify({ logits: trimmed }),
      });

      if (voteResult.received) {
        console.log(`${tag} Voted: ${trimmed.map((l) => l.toFixed(2)).join(', ')}`);
      } else {
        console.log(`${tag} Vote failed: ${voteResult.error || 'unknown'}`);
      }
    }
  } catch (err: any) {
    console.error(`[${bot.personality.name}] Vote error:`, err.message || err);
  }

  // Done with this room regardless
  bot.currentRoom = null;
  bot.currentTopic = null;
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
      currentHandle: null,
      messagesSent: 0,
      lastMessageTime: 0,
      roomJoinedAt: 0,
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
