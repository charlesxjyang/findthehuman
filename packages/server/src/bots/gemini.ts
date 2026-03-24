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
        maxOutputTokens: 250,
        temperature: 0.9,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as any;
  // Gemini 2.5 may return thinking in separate parts — get the last text part
  const parts = data.candidates?.[0]?.content?.parts || [];
  const textParts = parts.filter((p: any) => p.text && !p.thought);
  const text = textParts[textParts.length - 1]?.text?.trim() || '';
  // Strip any remaining think tags
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export async function generateLogits(
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

  const prompt = `${systemPrompt}
${selfNote}

Here is the conversation from a "Find the Human" game. One participant is a human, the rest are AI bots. Analyze the conversation and determine who is most likely the human.

${conversationSummary}

Participants to evaluate: ${otherHandles.join(', ')}

First, briefly explain your reasoning for each participant (2-3 sentences each). Then on a final line, output ONLY a JSON array of numbers, one per participant in the order listed above. Higher = more likely human. Example: [1.2, -0.5, 3.1, 0.0]`;

  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 500,
        temperature: 0.3,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}`);
  }

  const data = (await res.json()) as any;
  const parts = data.candidates?.[0]?.content?.parts || [];
  const textParts = parts.filter((p: any) => p.text && !p.thought);
  const text = textParts.map((p: any) => p.text).join('\n').trim();

  // Extract JSON array from response
  const match = text.match(/\[[\d\s,.\-]+\]/);
  if (match) {
    const parsed = JSON.parse(match[0]) as number[];
    if (parsed.length === otherHandles.length) {
      // Re-insert a low score for self at the correct position
      if (ownHandle) {
        const selfIndex = participantHandles.indexOf(ownHandle);
        if (selfIndex !== -1) {
          parsed.splice(selfIndex, 0, -10);
        }
      }
      return parsed;
    }
  }

  // Fallback: random logits, low for self
  return participantHandles.map((h) => h === ownHandle ? -10 : Math.random() * 4 - 2);
}
