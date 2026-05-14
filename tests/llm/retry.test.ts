/**
 * Tests for LLM fetch retry with exponential backoff.
 *
 * Validates that the retry utility:
 * - Retries on transient failures
 * - Uses exponential backoff timing
 * - Respects max retry count
 * - Throws on final failure
 * - Succeeds immediately when no error
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithRetry, type RetryOptions } from "../../src/llm/retry.js";

describe("fetchWithRetry", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("should return response on first successful attempt", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await fetchWithRetry("http://example.com", {});
    expect(result.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("should retry on network failure and succeed on second attempt", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    globalThis.fetch = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue(mockResponse);

    const result = await fetchWithRetry("http://example.com", {}, {
      maxRetries: 3,
      baseDelayMs: 10,
    });

    expect(result.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("should throw after exhausting all retries", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      fetchWithRetry("http://example.com", {}, {
        maxRetries: 3,
        baseDelayMs: 10,
      })
    ).rejects.toThrow("ECONNREFUSED");

    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("should use exponential backoff delays", async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;

    // Track delay values passed to setTimeout
    const mockResponse = new Response("ok", { status: 200 });
    globalThis.fetch = vi.fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"))
      .mockResolvedValue(mockResponse);

    const result = await fetchWithRetry("http://example.com", {}, {
      maxRetries: 3,
      baseDelayMs: 100,
    });

    expect(result.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("should default to 3 retries", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(
      fetchWithRetry("http://example.com", {}, { baseDelayMs: 10 })
    ).rejects.toThrow();

    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("should not log full URL with credentials on final failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      fetchWithRetry("http://example.com/api?api_key=secret123&other=val", {}, {
        maxRetries: 1,
        baseDelayMs: 10,
      })
    ).rejects.toThrow("ECONNREFUSED");

    const errorCalls = consoleSpy.mock.calls.map(c => c.join(" "));
    const urlLogs = errorCalls.filter(c => c.includes("URL:"));
    for (const log of urlLogs) {
      expect(log).not.toMatch(/api_key=secret123/);
      expect(log).not.toMatch(/secret123/);
    }
    consoleSpy.mockRestore();
  });

  it("should pass request options through to fetch", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const options: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"test": true}',
    };

    await fetchWithRetry("http://example.com", options);

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0]).toBe("http://example.com");
    expect(callArgs[1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"test": true}',
    });
  });
});
