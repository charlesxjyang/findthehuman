const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.3-70b-versatile';

async function groqCall(
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
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: maxTokens,
      temperature,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content?.trim() || '';
}

export async function chatCompletion(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const userMessage = messages.map((m) => m.content).join('\n');
  return groqCall(systemPrompt, userMessage, 150, 0.9);
}

export async function generateLogits(
  systemPrompt: string,
  conversationSummary: string,
  participantHandles: string[],
): Promise<number[]> {
  const prompt = `${conversationSummary}

Participants: ${participantHandles.join(', ')}

Respond with ONLY a JSON array of numbers, one per participant in the same order. Higher = more likely human. Example for ${participantHandles.length} participants: [1.2, -0.5, 3.1, 0.0, -1.0, 2.5]`;

  const text = await groqCall(systemPrompt, prompt, 100, 0.3);

  const match = text.match(/\[[\d\s,.\-]+\]/);
  if (match) {
    const parsed = JSON.parse(match[0]) as number[];
    if (parsed.length === participantHandles.length) {
      return parsed;
    }
  }

  return participantHandles.map(() => Math.random() * 4 - 2);
}
