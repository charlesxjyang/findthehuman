const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

async function openaiCall(
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
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
    throw new Error(`OpenAI API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content?.trim() || '';
}

export function makeOpenAIProvider(model: string) {
  return {
    async chatCompletion(
      systemPrompt: string,
      messages: Array<{ role: string; content: string }>,
    ): Promise<string> {
      const userMessage = messages.map((m) => m.content).join('\n');
      return openaiCall(model, systemPrompt, userMessage, 250, 0.9);
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

      const text = await openaiCall(model, systemPrompt, prompt, 500, 0.3);

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

export const gpt5mini = makeOpenAIProvider('gpt-5-mini');
