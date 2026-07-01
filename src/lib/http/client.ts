/**
 * Shared HTTP client for external integration APIs
 *
 * Wraps fetch with the plumbing every REST client needs: a per-attempt
 * timeout, retries for transient failures (network errors, 429 rate-limits,
 * 5xx server errors) with Retry-After support, and JSON encoding/decoding.
 * The retry loop is lifted from the Printify client, where it was
 * battle-tested: a hung request must never stall a caller forever (a
 * background worker's overlap guard would keep `running = true` and
 * permanently wedge its sync loop), so every attempt is bounded by a timeout
 * and only transient failures are retried with a short backoff.
 */

export interface HttpRetryConfig {
  /** Total attempts including the first (default 4). */
  retries?: number;
  /** Base backoff in ms; attempt N waits N * backoffMs (default 1500). */
  backoffMs?: number;
  /** Honor the Retry-After header on 429/5xx responses (default true). */
  respectRetryAfter?: boolean;
}

export interface HttpClientConfig {
  baseUrl: string;
  /** Headers sent on every request (auth, Accept, Content-Type...). */
  defaultHeaders?: Record<string, string>;
  /** Per-attempt timeout in ms (default 20000). */
  timeoutMs?: number;
  retry?: HttpRetryConfig;
  /**
   * Build the error thrown for a non-retryable (or retries-exhausted) HTTP
   * error status. Lets each integration keep its exact error messages so
   * callers matching on them keep working.
   */
  buildError?: (status: number, bodyText: string) => Error;
}

export interface HttpRequestOptions<T> {
  method?: string;
  /** Merged over the client's defaultHeaders. */
  headers?: Record<string, string>;
  /** Query params appended to the URL. */
  query?: Record<string, string | number>;
  /** JSON-encoded request body (omitted when undefined). */
  body?: unknown;
  /**
   * Custom parser for a 2xx response (default: response.json()). Errors
   * thrown here are treated as transient and retried, matching the historic
   * Printify behavior for a body that dies mid-read - wrap application-level
   * errors in noRetry() to make them final.
   */
  parse?: (response: Response) => Promise<T>;
}

const NO_RETRY = Symbol('httpNoRetry');

/**
 * Mark an error as final: the retry loop rethrows it immediately instead of
 * treating it as a transient network failure.
 */
export function noRetry<E extends Error>(err: E): E {
  (err as E & { [NO_RETRY]?: boolean })[NO_RETRY] = true;
  return err;
}

function isNoRetry(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { [NO_RETRY]?: boolean })[NO_RETRY] === true
  );
}

export class HttpClient {
  private config: HttpClientConfig;

  constructor(config: HttpClientConfig) {
    this.config = config;
  }

  /**
   * Make an API request with timeout + transient-failure retries
   */
  async request<T>(
    path: string,
    options: HttpRequestOptions<T> = {}
  ): Promise<T> {
    const url = new URL(`${this.config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query || {})) {
      url.searchParams.set(key, String(value));
    }

    const timeoutMs = this.config.timeoutMs ?? 20_000;
    const maxAttempts = this.config.retry?.retries ?? 4;
    const backoffMs = this.config.retry?.backoffMs ?? 1500;
    const respectRetryAfter = this.config.retry?.respectRetryAfter ?? true;
    const buildError =
      this.config.buildError ??
      ((status: number, text: string) =>
        new Error(`HTTP error: ${status} - ${text}`));

    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url.toString(), {
          method: options.method || 'GET',
          headers: { ...this.config.defaultHeaders, ...options.headers },
          body:
            options.body !== undefined
              ? JSON.stringify(options.body)
              : undefined,
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text();
          // Retry rate-limits and server errors; fail fast on 4xx (auth, bad
          // request) which won't get better on retry.
          if (
            (response.status === 429 || response.status >= 500) &&
            attempt < maxAttempts
          ) {
            const retryAfter = respectRetryAfter
              ? parseInt(response.headers.get('retry-after') || '', 10)
              : NaN;
            const backoff = Number.isNaN(retryAfter)
              ? attempt * backoffMs
              : retryAfter * 1000;
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
          throw noRetry(buildError(response.status, text));
        }

        if (options.parse) {
          return await options.parse(response);
        }
        return (await response.json()) as T;
      } catch (err) {
        lastErr = err;
        // Network/abort errors are transient - back off and retry.
        if (isNoRetry(err) || attempt >= maxAttempts) throw err;
        await new Promise((r) => setTimeout(r, attempt * backoffMs));
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error('HTTP request failed');
  }
}
