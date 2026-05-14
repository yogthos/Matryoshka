/**
 * Shared fetch retry utility with exponential backoff.
 *
 * Used by LLM providers (Ollama, DeepSeek) for resilient API calls.
 */

export interface RetryOptions {
  /** Maximum number of attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelayMs?: number;
  /** Request timeout in ms (default: 120000) */
  timeoutMs?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 120_000;

function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Fetch with retry and exponential backoff.
 *
 * Retries on network errors (ECONNREFUSED, timeout, etc.).
 * Backoff formula: baseDelay * 2^(attempt-1) — e.g., 1s, 2s, 4s.
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retryOptions: RetryOptions = {}
): Promise<Response> {
  const maxRetries = retryOptions.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = retryOptions.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const timeoutMs = retryOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (attempt === maxRetries) {
        console.error(`Final fetch attempt failed: ${errMsg}`);
        console.error(`URL: ${sanitizeUrl(url)}`);
        throw error;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.error(
        `Fetch attempt ${attempt}/${maxRetries} failed (${errMsg}), retrying in ${delay}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw new Error("Unreachable");
}
