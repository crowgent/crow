import { APICallError } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { computeRetryDelayMs, getRetryAfterMs, isRetryableError } from "../../src/agent/retry";

function apiError(statusCode: number, responseHeaders?: Record<string, string>): APICallError {
  return new APICallError({
    message: `Request failed with status ${statusCode}`,
    url: "https://example.test/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseHeaders,
  });
}

describe("isRetryableError", () => {
  it("retries rate limits and server overload", () => {
    expect(isRetryableError(apiError(429))).toBe(true);
    expect(isRetryableError(apiError(503))).toBe(true);
    expect(isRetryableError(apiError(529))).toBe(true);
    expect(isRetryableError(apiError(500))).toBe(true);
  });

  it("does not retry auth, client, or context errors", () => {
    expect(isRetryableError(apiError(401))).toBe(false);
    expect(isRetryableError(apiError(403))).toBe(false);
    expect(isRetryableError(apiError(400))).toBe(false);
    expect(isRetryableError(apiError(404))).toBe(false);
    expect(isRetryableError(new Error("maximum context length exceeded"))).toBe(false);
    expect(isRetryableError(new Error("too many tokens"))).toBe(false);
  });

  it("retries transport failures", () => {
    expect(isRetryableError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableError(new Error("socket hang up"))).toBe(true);
    expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
  });
});

describe("getRetryAfterMs", () => {
  it("reads retry-after seconds", () => {
    expect(getRetryAfterMs(apiError(429, { "retry-after": "2" }))).toBe(2000);
  });

  it("caps retry-after at fifteen minutes", () => {
    expect(getRetryAfterMs(apiError(429, { "Retry-After": "3600" }))).toBe(15 * 60 * 1000);
  });

  it("returns null without the header", () => {
    expect(getRetryAfterMs(apiError(429))).toBeNull();
    expect(getRetryAfterMs(new Error("fetch failed"))).toBeNull();
  });
});

describe("computeRetryDelayMs", () => {
  it("honors retry-after over backoff", () => {
    expect(computeRetryDelayMs(3, apiError(429, { "retry-after": "5" }))).toBe(5000);
  });

  it("backs off exponentially up to the cap", () => {
    const first = computeRetryDelayMs(0, apiError(503));
    expect(first).toBeGreaterThanOrEqual(1500);
    expect(first).toBeLessThanOrEqual(2500);
    const late = computeRetryDelayMs(9, apiError(503));
    expect(late).toBeGreaterThanOrEqual(7500);
    expect(late).toBeLessThanOrEqual(12500);
  });
});
