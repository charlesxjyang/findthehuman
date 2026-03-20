import { describe, it, expect } from 'vitest';
import { softmax, computeScores, updateElo } from '../scoring.js';

describe('softmax', () => {
  it('should produce a valid probability distribution', () => {
    const probs = softmax([1, 2, 3, 4]);
    expect(probs.length).toBe(4);
    const sum = probs.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0);
    probs.forEach((p) => expect(p).toBeGreaterThan(0));
  });

  it('should handle equal logits', () => {
    const probs = softmax([0, 0, 0, 0, 0, 0]);
    probs.forEach((p) => expect(p).toBeCloseTo(1 / 6));
  });

  it('should be numerically stable with large values', () => {
    const probs = softmax([1000, 1001, 1002]);
    const sum = probs.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0);
  });
});

describe('computeScores', () => {
  it('should compute stealth and detection scores', () => {
    const participantIds = ['human', 'bot1', 'bot2', 'bot3', 'bot4', 'bot5'];
    const humanIndex = 0;

    // Bots assign high logit to the human (index 0) — human should have low stealth
    const votes = new Map<string, number[]>();
    votes.set('bot1', [5, 0, 0, 0, 0, 0]);
    votes.set('bot2', [5, 0, 0, 0, 0, 0]);
    votes.set('bot3', [5, 0, 0, 0, 0, 0]);
    votes.set('bot4', [5, 0, 0, 0, 0, 0]);
    votes.set('bot5', [5, 0, 0, 0, 0, 0]);

    const result = computeScores(votes, humanIndex, participantIds);

    // All bots strongly identify the human
    expect(result.humanStealthScore).toBeLessThan(0.2);
    result.botResults.forEach((r) => {
      expect(r.detectionScore).toBeGreaterThan(0.5);
    });
  });

  it('should give high stealth when bots are confused', () => {
    const participantIds = ['human', 'bot1', 'bot2', 'bot3', 'bot4', 'bot5'];
    const humanIndex = 0;

    // Bots assign equal logits — can't tell who's human
    const votes = new Map<string, number[]>();
    votes.set('bot1', [0, 0, 0, 0, 0, 0]);
    votes.set('bot2', [0, 0, 0, 0, 0, 0]);
    votes.set('bot3', [0, 0, 0, 0, 0, 0]);

    const result = computeScores(votes, humanIndex, participantIds);

    // Stealth ≈ 1 - 1/6 ≈ 0.833
    expect(result.humanStealthScore).toBeCloseTo(1 - 1 / 6, 1);
  });
});

describe('updateElo', () => {
  it('should increase Elo on win against equal opponent', () => {
    const newElo = updateElo(1200, 1200, 1);
    expect(newElo).toBe(1216);
  });

  it('should decrease Elo on loss against equal opponent', () => {
    const newElo = updateElo(1200, 1200, 0);
    expect(newElo).toBe(1184);
  });

  it('should increase more for upset wins', () => {
    const eloWinAgainstHigher = updateElo(1200, 1400, 1);
    const eloWinAgainstEqual = updateElo(1200, 1200, 1);
    expect(eloWinAgainstHigher - 1200).toBeGreaterThan(eloWinAgainstEqual - 1200);
  });

  it('should decrease less for expected losses', () => {
    const eloLossAgainstHigher = updateElo(1200, 1400, 0);
    const eloLossAgainstEqual = updateElo(1200, 1200, 0);
    expect(1200 - eloLossAgainstHigher).toBeLessThan(1200 - eloLossAgainstEqual);
  });
});
