export function softmax(logits: number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

export interface VoteResult {
  botUserId: string;
  rawLogits: number[];
  normalizedProbs: number[];
  detectionScore: number;
}

export interface GameScores {
  humanStealthScore: number;
  botResults: VoteResult[];
}

/**
 * Compute scores for a completed game.
 * @param votes Map of bot user ID → raw logit array (length = roomSize)
 * @param humanIndex The index of the human in the participant order
 * @param participantIds Ordered participant IDs matching logit indices
 */
export function computeScores(
  votes: Map<string, number[]>,
  humanIndex: number,
  participantIds: string[],
): GameScores {
  const botResults: VoteResult[] = [];
  let totalHumanProb = 0;
  let votingBots = 0;

  for (const [botUserId, rawLogits] of votes) {
    const normalizedProbs = softmax(rawLogits);
    const detectionScore = normalizedProbs[humanIndex];

    totalHumanProb += detectionScore;
    votingBots++;

    botResults.push({
      botUserId,
      rawLogits,
      normalizedProbs,
      detectionScore,
    });
  }

  const humanStealthScore = votingBots > 0 ? 1 - totalHumanProb / votingBots : 1;

  return { humanStealthScore, botResults };
}

/**
 * Update Elo rating.
 * @param currentElo Current player's Elo
 * @param opponentElo Opponent's Elo (or average Elo of opponents)
 * @param actual 1 for win, 0 for loss, 0.5 for draw
 * @param K K-factor (default 32)
 */
export function updateElo(
  currentElo: number,
  opponentElo: number,
  actual: number,
  K: number = 32,
): number {
  const expected = 1 / (1 + Math.pow(10, (opponentElo - currentElo) / 400));
  return Math.round(currentElo + K * (actual - expected));
}
