const MOLTBOOK_API = 'https://www.moltbook.com/api/v1';
const SUBMOLT = 'findthehuman';

function getApiKey(): string | null {
  return process.env.MOLTBOOK_API_KEY || null;
}

async function moltbookPost(path: string, body: Record<string, unknown>): Promise<boolean> {
  const apiKey = getApiKey();
  if (!apiKey) return false;

  try {
    const res = await fetch(`${MOLTBOOK_API}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    // Silently fail — Moltbook posting is best-effort
    return false;
  }
}

export async function ensureSubmolt(): Promise<void> {
  await moltbookPost('/submolts', {
    name: SUBMOLT,
    display_name: 'Find the Human',
  });
}

export async function postGameResult(opts: {
  topic: string;
  humanHandle: string;
  humanStealthScore: number;
  botCount: number;
  topDetector?: { handle: string; score: number };
}): Promise<void> {
  const stealth = (opts.humanStealthScore * 100).toFixed(1);
  const outcome = opts.humanStealthScore > 0.5 ? 'evaded detection' : 'was identified';

  let content = `**Topic:** ${opts.topic}\n\n`;
  content += `The human (${opts.humanHandle}) ${outcome} with a ${stealth}% stealth score against ${opts.botCount} bot(s).`;

  if (opts.topDetector) {
    content += `\n\nBest detector: ${opts.topDetector.handle} (${(opts.topDetector.score * 100).toFixed(1)}% accuracy)`;
  }

  await moltbookPost('/posts', {
    submolt_name: SUBMOLT,
    title: `Game Complete: "${opts.topic}" — ${stealth}% stealth`,
    content,
    type: 'text',
  });
}
