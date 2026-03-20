const MOLTBOOK_API = 'https://www.moltbook.com/api/v1';
const SUBMOLT = 'findthehuman';

function getApiKey(): string | null {
  return process.env.MOLTBOOK_API_KEY || null;
}

function getHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getApiKey()}`,
  };
}

/**
 * Solve the obfuscated math verification challenge.
 * Challenges look like: "LoB-StEr ClA-w FoRcE SeVeNnTy NoOtOnS * TwO ClAwS, HoW MuCh ToTaL FoRcE?"
 * We need to extract the numbers and operation, compute, and return the answer.
 */
function solveChallenge(challenge: string): string {
  // Normalize: strip non-alpha chars between letters, lowercase
  const clean = challenge.replace(/[^a-zA-Z0-9.*+\-/,? ]/g, ' ').replace(/\s+/g, ' ').toLowerCase();

  // Map word numbers to values
  const wordNums: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
    seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
  };

  // Extract numbers (both digit and word forms)
  const numbers: number[] = [];

  // Find digit numbers
  const digitMatches = clean.match(/\d+\.?\d*/g);
  if (digitMatches) {
    numbers.push(...digitMatches.map(Number));
  }

  // Find word numbers — strip extra letters from obfuscation
  for (const [word, val] of Object.entries(wordNums)) {
    // Check if the word's letters appear in sequence in the clean text
    const pattern = word.split('').join('[a-z]*');
    const re = new RegExp(pattern, 'i');
    if (re.test(clean)) {
      numbers.push(val);
    }
  }

  // Detect operation
  let result = 0;
  if (clean.includes('*') || clean.includes('times') || clean.includes('total')) {
    result = numbers.reduce((a, b) => a * b, 1);
  } else if (clean.includes('+') || clean.includes('plus') || clean.includes('sum') || clean.includes('add')) {
    result = numbers.reduce((a, b) => a + b, 0);
  } else if (clean.includes('-') || clean.includes('minus') || clean.includes('subtract')) {
    result = numbers.length >= 2 ? numbers[0] - numbers[1] : numbers[0] || 0;
  } else if (clean.includes('/') || clean.includes('divide')) {
    result = numbers.length >= 2 && numbers[1] !== 0 ? numbers[0] / numbers[1] : 0;
  } else {
    // Default: multiply if multiple numbers found
    result = numbers.length > 1 ? numbers.reduce((a, b) => a * b, 1) : numbers[0] || 0;
  }

  return result.toFixed(2);
}

async function moltbookPostWithVerify(
  path: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  const apiKey = getApiKey();
  if (!apiKey) return false;

  try {
    const res = await fetch(`${MOLTBOOK_API}${path}`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) return false;

    const data = (await res.json()) as any;

    // Handle verification challenge if present
    if (data?.post?.verification_status === 'pending' && data?.post?.verification) {
      const { verification_code, challenge_text } = data.post.verification;
      if (verification_code && challenge_text) {
        const answer = solveChallenge(challenge_text);
        await fetch(`${MOLTBOOK_API}/verify`, {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({ verification_code, answer }),
        });
      }
    }

    return true;
  } catch {
    return false;
  }
}

export async function ensureSubmolt(): Promise<void> {
  const apiKey = getApiKey();
  if (!apiKey) return;

  try {
    await fetch(`${MOLTBOOK_API}/submolts`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ name: SUBMOLT, display_name: 'Find the Human' }),
    });
  } catch {
    // Already exists or failed — either way, continue
  }
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

  await moltbookPostWithVerify('/posts', {
    submolt_name: SUBMOLT,
    title: `Game Complete: "${opts.topic}" — ${stealth}% stealth`,
    content,
    type: 'text',
  });
}
