import { HttpResponseError, NetworkError } from './Error.ts';

/** Signals that durable issuance state is intact and processor retry backoff should apply. */
export class MintIssuanceRetryError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'MintIssuanceRetryError';
  }
}

/** Recognizes retryable issuance failures through domain wrappers such as MintFetchError. */
export function isRetryableMintIssuanceError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (
      current instanceof MintIssuanceRetryError ||
      current instanceof NetworkError ||
      (current instanceof HttpResponseError && (current.status === 429 || current.status >= 500))
    ) {
      return true;
    }
    seen.add(current);
    current =
      typeof current === 'object' && 'cause' in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}
