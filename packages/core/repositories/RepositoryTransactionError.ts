/**
 * Reports transient adapter contention while acquiring or committing a Wallet transaction.
 * Callers may apply a bounded retry policy to this error; domain and invariant errors must pass
 * through unchanged.
 *
 * @remarks
 * Unstable repository contract starting with v3: minor or major releases may introduce
 * breaking changes with adapter migration notes. Patch releases preserve compatibility.
 *
 * @see {@link https://github.com/cashubtc/coco/blob/master/packages/core/README.md#repository-compatibility | Repository compatibility policy}
 */
export class RepositoryTransactionConflictError extends Error {
  readonly transient = true;

  constructor(message = 'Wallet repository transaction conflicted', cause?: unknown) {
    super(message);
    this.name = 'RepositoryTransactionConflictError';
    (this as unknown as { cause?: unknown }).cause = cause;
  }
}
