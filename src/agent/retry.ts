import { APICallError } from "@ai-sdk/provider";
import { isAuthenticationError, isContextLimitError } from "./errors";

export const MAX_MODEL_RETRIES = 10;
const RETRY_AFTER_MAX_MS = 15 * 60 * 1000;
const RETRY_BASE_MS = 2000;
const RETRY_CAP_MS = 10000;

const TRANSPORT_PATTERNS =
  /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|connection (reset|aborted|terminated)|temporarily unavailable|service unavailable|overloaded|rate limit|too many requests/i;

export function isRetryableError(error: unknown): boolean {
  if (isAuthenticationError(error) || isContextLimitError(error)) return false;
  if (APICallError.isInstance(error)) {
    if (typeof error.isRetryable === "boolean") return error.isRetryable;
    if (typeof error.statusCode === "number") {
      return [408, 409, 429, 500, 502, 503, 504].includes(error.statusCode);
    }
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return TRANSPORT_PATTERNS.test(message);
}

export function getRetryAfterMs(error: unknown): number | null {
  if (!APICallError.isInstance(error) || !error.responseHeaders) return null;
  const entry = Object.entries(error.responseHeaders).find(([key]) => key.toLowerCase() === "retry-after");
  if (!entry) return null;
  const raw = entry[1].trim();
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.min(dateMs - Date.now(), RETRY_AFTER_MAX_MS));
  }
  return null;
}

export function computeRetryDelayMs(attempt: number, error: unknown): number {
  const retryAfter = getRetryAfterMs(error);
  if (retryAfter !== null) return retryAfter;
  const backoff = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
  return Math.round(backoff * (0.75 + Math.random() * 0.5));
}

export function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
