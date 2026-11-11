/**
 * Small fuzzy matcher for the command palette: every query character must
 * appear in order. Scores reward consecutive matches, word starts and prefix
 * matches. Returns null when there is no match.
 */
export function fuzzyScore(query: string, text: string): { score: number; indices: number[] } | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    indices.push(found);
    const atWordStart = found === 0 || /[\s\-_:/.]/.test(t[found - 1] ?? "");
    score += 1;
    if (found === prev + 1) score += 4;
    if (atWordStart) score += 3;
    if (found === 0) score += 2;
    score -= Math.min(found - ti, 5) * 0.2;
    prev = found;
    ti = found + 1;
  }
  // Prefer shorter texts for equal matches.
  score -= text.length * 0.01;
  return { score, indices };
}

export function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string): T[] {
  if (!query.trim()) return items;
  return items
    .map((item) => ({ item, m: fuzzyScore(query, key(item)) }))
    .filter((x): x is { item: T; m: { score: number; indices: number[] } } => x.m !== null)
    .sort((a, b) => b.m.score - a.m.score)
    .map((x) => x.item);
}
