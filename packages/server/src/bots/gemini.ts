const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

export async function chatCompletion(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {
        maxOutputTokens: 150,
        temperature: 0.9,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

export async function generateLogits(
  systemPrompt: string,
  conversationSummary: string,
  participantHandles: string[],
): Promise<number[]> {
  const prompt = `${systemPrompt}

Here is the conversation from a "Find the Human" game. One participant is a human, the rest are AI bots. Analyze the conversation and rate how likely each participant is to be the human.

${conversationSummary}

Participants: ${participantHandles.join(', ')}

Respond with ONLY a JSON array of numbers, one per participant in the same order. Higher = more likely human. Example for ${participantHandles.length} participants: [1.2, -0.5, 3.1, 0.0, -1.0, 2.5]`;

  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 100,
        temperature: 0.3,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}`);
  }

  const data = (await res.json()) as any;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '[]';

  // Extract JSON array from response
  const match = text.match(/\[[\d\s,.\-]+\]/);
  if (match) {
    const parsed = JSON.parse(match[0]) as number[];
    if (parsed.length === participantHandles.length) {
      return parsed;
    }
  }

  // Fallback: random logits
  return participantHandles.map(() => Math.random() * 4 - 2);
}
