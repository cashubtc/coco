import type { Logger } from '../logging/Logger.ts';
import { HttpResponseError, NetworkError, MintOperationError } from '../models/Error';

type RequestFunction = <T>(
  options: {
    endpoint: string;
    requestBody?: Record<string, unknown>;
    headers?: Record<string, string>;
  } & Omit<RequestInit, 'body' | 'headers'>,
) => Promise<T>;

interface RateLimiterOptions {
  capacity?: number;
  refillPerMinute?: number;
  bypassPathPrefixes?: string[];
  logger?: Logger;
}

/**
 * Token-bucket based request rate limiter that exposes a request-compatible API
 * for the cashu-ts `_customRequest` parameter.
 *
 * - Token capacity determines max burst size.
 * - Tokens refill continuously based on `refillPerMinute`.
 * - Paths starting with any configured prefix are not throttled.
 * - Requests are queued FIFO when tokens are exhausted.
 */
export class RequestRateLimiter {
  private readonly capacity: number;
  private readonly refillPerMinute: number;
  private tokens: number;
  private lastRefillAt: number;
  private readonly bypassPathPrefixes: string[];
  private readonly logger?: Logger;

  private queue: Array<() => void> = [];
  private processingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options?: RateLimiterOptions) {
    this.capacity = Math.max(1, options?.capacity ?? 25);
    this.refillPerMinute = Math.max(1, options?.refillPerMinute ?? 25);
    this.tokens = this.capacity; // start full to allow immediate bursts
    this.lastRefillAt = Date.now();
    this.bypassPathPrefixes = options?.bypassPathPrefixes ?? [];
    this.logger = options?.logger;
  }

  /**
   * The request function compatible with cashu-ts's `request(options)` signature.
   * It uses the global fetch under the hood.
   */
  public request: RequestFunction = async (options) => {
    const url = new URL(options.endpoint);
    const shouldBypass = this.shouldBypass(url.pathname);

    if (shouldBypass) {
      return this.performFetch(options);
    }

    await this.acquireToken();
    try {
      return await this.performFetch(options);
    } finally {
      this.scheduleProcessingIfNeeded();
    }
  };

  private shouldBypass(pathname: string): boolean {
    if (!this.bypassPathPrefixes.length) return false;
    return this.bypassPathPrefixes.some((p) => pathname.startsWith(p));
  }

  private performFetch = async <T>(
    options: {
      endpoint: string;
      requestBody?: Record<string, unknown>;
      headers?: Record<string, string>;
    } & Omit<RequestInit, 'body' | 'headers'>,
  ): Promise<T> => {
    const { endpoint, requestBody, headers, ...init } = options;

    // Build headers with sensible defaults and conditional Content-Type
    const finalHeaders = new Headers({
      Accept: 'application/json, text/plain, */*',
      ...(headers || {}),
    });
    // Avoid DOM-specific BodyInit type to keep this file platform-agnostic
    let body: unknown | undefined = undefined;
    if (requestBody !== undefined) {
      finalHeaders.set('Content-Type', 'application/json');
      body = JSON.stringify(requestBody);
    }

    let response: Response;
    try {
      response = await fetch(endpoint, {
        ...(init as any),
        headers: finalHeaders as any,
        body: body as any,
      } as any);
    } catch (err) {
      throw new NetworkError(err instanceof Error ? err.message : 'Network request failed');
    }

    if (!response.ok) {
      type ErrorShape =
        | { error?: unknown; detail?: unknown; code?: unknown }
        | Record<string, unknown>;
      let errorData: ErrorShape = { error: 'bad response' };
      try {
        errorData = (await response.clone().json()) as ErrorShape;
      } catch {
        // leave default errorData
      }

      const hasProtocolError =
        response.status === 400 &&
        errorData &&
        typeof (errorData as any).code === 'number' &&
        typeof (errorData as any).detail === 'string';
      if (hasProtocolError) {
        const { code, detail } = errorData as { code: number; detail: string };
        throw new MintOperationError(code, detail);
      }

      let errorMessage = 'HTTP request failed';
      const anyErr = errorData as any;
      if (typeof anyErr?.error === 'string') errorMessage = anyErr.error;
      else if (typeof anyErr?.detail === 'string') errorMessage = anyErr.detail;

      throw new HttpResponseError(errorMessage, response.status);
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      this.logger?.error('Failed to parse HTTP response', err as unknown);
      throw new HttpResponseError('bad response', response.status);
    }
  };

  private acquireToken(): Promise<void> {
    this.refillTokens();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.logger?.debug('RateLimiter token granted immediately', {
        tokens: this.tokens,
        capacity: this.capacity,
      });
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.queue.push(() => {
        resolve();
      });
      this.logger?.debug('Queued request due to empty bucket', { queueLength: this.queue.length });
      this.scheduleProcessingIfNeeded();
    });
  }

  private scheduleProcessingIfNeeded(): void {
    if (this.processingTimer) return;
    const delayMs = this.msUntilNextToken();
    this.processingTimer = setTimeout(() => {
      this.processingTimer = null;
      this.processQueue();
    }, delayMs);
  }

  private processQueue(): void {
    this.refillTokens();
    while (this.tokens >= 1 && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) continue;
      this.tokens -= 1;
      try {
        next();
      } catch (err) {
        this.logger?.error('RateLimiter queue task error', err as unknown);
      }
    }

    if (this.queue.length > 0) {
      this.scheduleProcessingIfNeeded();
    }
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillAt;
    if (elapsedMs <= 0) return;
    const tokensPerMs = this.refillPerMinute / 60000;
    const refill = elapsedMs * tokensPerMs;
    const newTokens = Math.min(this.capacity, this.tokens + refill);
    if (newTokens !== this.tokens) {
      this.tokens = newTokens;
      this.lastRefillAt = now;
    } else {
      this.lastRefillAt = now;
    }
  }

  private msUntilNextToken(): number {
    this.refillTokens();
    if (this.tokens >= 1) return 0;
    const tokensPerMs = this.refillPerMinute / 60000;
    const deficit = 1 - this.tokens; // tokens needed to reach 1
    return Math.max(1, Math.ceil(deficit / tokensPerMs));
  }
}
