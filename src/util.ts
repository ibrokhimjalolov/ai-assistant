export function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/**
 * Fraction of the context window used, from the SDK result's `modelUsage` record.
 * Returns the max over models of (input + cacheRead + cacheCreate) / contextWindow,
 * or null when there is no usable entry (missing data → never auto-rotate).
 */
export function contextFractionFromUsage(modelUsage: unknown): number | null {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  let max: number | null = null;
  for (const u of Object.values(modelUsage as Record<string, any>)) {
    if (!u || typeof u !== 'object') continue;
    const windowSize = Number(u.contextWindow);
    if (!Number.isFinite(windowSize) || windowSize <= 0) continue;
    const used =
      Number(u.inputTokens || 0) + Number(u.cacheReadInputTokens || 0) + Number(u.cacheCreationInputTokens || 0);
    const frac = used / windowSize;
    if (max === null || frac > max) max = frac;
  }
  return max;
}
