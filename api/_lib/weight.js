export const SCORE_TIERS = [
  { minScore: 0,    weight: 1 },
  { minScore: 1200, weight: 2 },
  { minScore: 1400, weight: 3 },
  { minScore: 1600, weight: 4 },
  { minScore: 1800, weight: 5 },
  { minScore: 2000, weight: 6 },
  { minScore: 2200, weight: 7 },
  { minScore: 2400, weight: 8 },
  { minScore: 2600, weight: 9 },
];

export function scoreToWeight(score) {
  const s = Number(score || 0);
  let w = SCORE_TIERS[0].weight;

  for (const t of SCORE_TIERS) {
    if (s >= t.minScore) w = t.weight;
  }
  return BigInt(w);
}
