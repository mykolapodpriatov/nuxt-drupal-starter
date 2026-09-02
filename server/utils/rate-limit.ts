/**
 * A small fixed-window rate limiter for write endpoints.
 *
 * In-memory and per-instance, which is the honest limitation: behind more than
 * one instance the effective limit multiplies by the instance count. That is
 * still worth having. The threat here is a script posting the contact form in a
 * loop, and an approximate limit stops that; a distributed limiter would mean
 * running Redis to defend a form.
 *
 * A fixed window rather than a sliding one for the same reason — it is a few
 * lines, and its known weakness (twice the limit across a window boundary) does
 * not matter at this scale.
 */
interface Window {
  count: number;
  /** Epoch milliseconds when this window resets. */
  resetAt: number;
}

const windows = new Map<string, Window>();

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window. */
  remaining: number;
  /** Seconds until the window resets — for a `Retry-After` header. */
  retryAfter: number;
}

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    // Opportunistic cleanup: without it the map grows by one entry per unique
    // client forever, which is a slow memory leak on a long-lived process.
    if (windows.size > 10_000) {
      for (const [entryKey, entry] of windows) {
        if (entry.resetAt <= now) windows.delete(entryKey);
      }
    }
    return { allowed: true, remaining: limit - 1, retryAfter: 0 };
  }

  existing.count += 1;
  const retryAfter = Math.ceil((existing.resetAt - now) / 1000);

  return {
    allowed: existing.count <= limit,
    remaining: Math.max(0, limit - existing.count),
    retryAfter,
  };
}

/** Drop all state. Tests only. */
export function resetRateLimits(): void {
  windows.clear();
}
