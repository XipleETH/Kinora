// Weekly scheduling utilities for infinite weekly cycle
// Week definition: Sunday 00:01 America/New_York to Saturday 23:59 America/New_York
// Sequential weekNumber starting at 1 from a configured epoch (default first Sunday after epoch)

// Base epoch (ms). Change if you want week 1 to start at a specific historical point.
// For now: 2025-01-05 00:01 ET (first Sunday of 2025 at 00:01 local)
const BASE_EPOCH = Date.UTC(2025, 0, 5, 5, 1, 0, 0); // 05:01 UTC corresponds approx 00:01 EST (UTC-5) / 01:01 EDT if DST (not in Jan)

export interface WeekBoundaries {
  weekNumber: number;
  startMs: number; // inclusive
  endMs: number;   // inclusive end Saturday 23:59:59.999 local
}



export function getWeekNumber(nowMs = Date.now()): number {
  if (nowMs < BASE_EPOCH) return 1;
  // We iterate forward in whole weeks from base until surpass now
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const diff = nowMs - BASE_EPOCH;
  return Math.floor(diff / weekMs) + 1;
}

export function getWeekBoundaries(weekNumber: number): WeekBoundaries {
  if (weekNumber < 1) weekNumber = 1;
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const startMs = BASE_EPOCH + (weekNumber - 1) * weekMs; // This is Sunday 00:01 local converted to UTC at epoch computation
  // End: Saturday 23:59:59.999 local => which is Sunday 00:00:00 - 1ms
  const nextStartMs = startMs + weekMs;
  const endMs = nextStartMs - 1; // inclusive
  return { weekNumber, startMs, endMs };
}

export function getCurrentWeekInfo(nowMs = Date.now()): WeekBoundaries {
  const w = getWeekNumber(nowMs);
  return getWeekBoundaries(w);
}

export function secondsUntilWeekEnd(nowMs = Date.now()): number {
  const { endMs } = getCurrentWeekInfo(nowMs);
  const diff = Math.max(0, endMs - nowMs);
  return Math.floor(diff / 1000);
}

export function isWeekEnded(nowMs = Date.now()): boolean {
  const { endMs } = getCurrentWeekInfo(nowMs);
  return nowMs > endMs;
}

// Simple tie-breaker helper (earlier proposedAt wins)
export function pickWinner<T extends { votes:number; proposedAt:number }>(items: T[]): T | null {
  if (!items.length) return null;
  return items.reduce((best, item) => {
    if (!best) return item;
    if (item.votes > best.votes) return item;
    if (item.votes === best.votes && item.proposedAt < best.proposedAt) return item;
    return best; }, null as T | null);
}
