const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

async function groqCall(
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_completion_tokens: maxTokens,
      temperature,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as any;
  const raw = data.choices?.[0]?.message?.content?.trim() || '';
  // Strip <think> tags (DeepSeek R1 includes reasoning in output)
  return raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function makeProvider(model: string) {
  return {
    async chatCompletion(
      systemPrompt: string,
      messages: Array<{ role: string; content: string }>,
    ): Promise<string> {
      const userMessage = messages.map((m) => m.content).join('\n');
      return groqCall(model, systemPrompt, userMessage, 250, 0.9);
    },

    async generateLogits(
      systemPrompt: string,
      conversationSummary: string,
      participantHandles: string[],
      ownHandle?: string | null,
    ): Promise<number[]> {
      const otherHandles = ownHandle
        ? participantHandles.filter((h) => h !== ownHandle)
        : participantHandles;

      const selfNote = ownHandle
        ? `\n\nYou are "${ownHandle}" — you know you are a bot, so exclude yourself from consideration.`
        : '';

      const prompt = `${selfNote}

${conversationSummary}

Participants to evaluate: ${otherHandles.join(', ')}

First, briefly explain your reasoning for each participant (2-3 sentences each). Then on a final line, output ONLY a JSON array of numbers, one per participant in the order listed above. Higher = more likely human. Example: [1.2, -0.5, 3.1, 0.0]`;

      const text = await groqCall(model, systemPrompt, prompt, 500, 0.3);

      const match = text.match(/\[[\d\s,.\-]+\]/);
      if (match) {
        const parsed = JSON.parse(match[0]) as number[];
        if (parsed.length === otherHandles.length) {
          if (ownHandle) {
            const selfIndex = participantHandles.indexOf(ownHandle);
            if (selfIndex !== -1) {
              parsed.splice(selfIndex, 0, -10);
            }
          }
          return parsed;
        }
      }

      return participantHandles.map((h) => h === ownHandle ? -10 : Math.random() * 4 - 2);
    },
  };
}

export const llama = makeProvider('llama-3.3-70b-versatile');
export const qwen = makeProvider('qwen/qwen3-32b');
export const deepseek = makeProvider('deepseek-r1-distill-llama-70b');

// Default exports for backward compat
export const chatCompletion = llama.chatCompletion;
export const generateLogits = llama.generateLogits;
