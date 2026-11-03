import type { UnsubscribeHandler } from '@core/infra/SubscriptionManager.ts';
import type { Logger } from '../../logging/Logger.ts';
import { normalizeMintUrl } from '../../utils.ts';
import {
  quoteWatchKey,
  type QuoteWatchIdentity,
  type QuoteWatchInterests,
  type QuoteWatchOwner,
} from './QuoteWatchInterests.ts';

/** Physical observation state for one exact quote. */
export interface QuoteWatchHandle extends QuoteWatchIdentity {
  start?: Promise<void>;
  stop?: UnsubscribeHandler;
}

interface QuoteWatchRecordsOptions {
  /** Diagnostic label, for example `melt` or `mint`. */
  label: string;
  interests: QuoteWatchInterests;
  isTrustedMint(mintUrl: string): Promise<boolean>;
  logger?: Logger;
}

/**
 * Records and retirement shared by quote watchers. A record is current only while it is mapped
 * under its key. Retired cleanup stays visible per key, so a replacement can wait for the old
 * physical subscription to close before acquiring its own.
 */
export class QuoteWatchRecords<R extends QuoteWatchHandle> {
  private readonly byKey = new Map<string, R>();
  private readonly retiredByKey = new Map<string, Set<Promise<void>>>();
  private readonly ownerRemovals = new Map<string, Promise<void>>();

  constructor(private readonly options: QuoteWatchRecordsOptions) {}

  get(key: string): R | undefined {
    return this.byKey.get(key);
  }

  values(): R[] {
    return [...this.byKey.values()];
  }

  isCurrent(record: R): boolean {
    return this.byKey.get(quoteWatchKey(record)) === record;
  }

  ensure(key: string, create: () => R): R {
    let record = this.byKey.get(key);
    if (!record) this.byKey.set(key, (record = create()));
    return record;
  }

  /** Cleanup still releasing retired records for this key, if any. */
  retiredCleanup(key: string): Promise<void> | undefined {
    const retired = this.retiredByKey.get(key);
    return retired && Promise.all([...retired]).then(() => {});
  }

  /** Retire synchronously, then wait for the record's acquisition and unsubscribe. */
  stopWatching(key: string): Promise<void> {
    const record = this.byKey.get(key);
    if (!record) return this.retiredCleanup(key) ?? Promise.resolve();
    this.byKey.delete(key);
    const task = (async () => {
      try {
        await record.start;
        await record.stop?.();
      } catch (err) {
        this.options.logger?.warn(`Unsubscribe ${this.options.label} quote watcher failed`, {
          key,
          err,
        });
      }
    })();
    const retired = this.retiredByKey.get(key) ?? new Set<Promise<void>>();
    this.retiredByKey.set(key, retired);
    retired.add(task);
    void task.then(() => {
      retired.delete(task);
      if (!retired.size && this.retiredByKey.get(key) === retired) this.retiredByKey.delete(key);
    });
    return task;
  }

  /** Retire every record for a mint and wait for that mint's outstanding cleanup. */
  async stopWatchingMint(mintUrl: string): Promise<void> {
    const prefix = `${normalizeMintUrl(mintUrl)}::`;
    const cleanup = [...this.byKey.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => this.stopWatching(key));
    for (const [key, retired] of this.retiredByKey) {
      if (key.startsWith(prefix)) cleanup.push(...retired);
    }
    await Promise.all(cleanup);
  }

  /** Retire every record before awaiting any acquisition or unsubscribe. */
  async stopAll(): Promise<void> {
    for (const key of [...this.byKey.keys()]) void this.stopWatching(key);
    while (this.retiredByKey.size) {
      await Promise.all([...this.retiredByKey.values()].flatMap((tasks) => [...tasks]));
    }
  }

  /** Withdraw every declaration before waiting for acquisition, trust checks, or cleanup. */
  removeInterest(owner: QuoteWatchOwner): Promise<void> {
    const { interests } = this.options;
    const ownerKey = `${owner.kind}:${owner.id}`;
    const cleanup: Promise<void>[] = [];
    const previous = this.ownerRemovals.get(ownerKey);
    if (previous) cleanup.push(previous);
    for (const key of interests.keysFor(owner)) {
      interests.remove(key, owner);
      const record = this.byKey.get(key);
      if (!interests.hasAny(key)) cleanup.push(this.stopWatching(key));
      else if (record && !interests.hasRecovery(key)) cleanup.push(this.stopIfUntrusted(record));
    }
    const task = Promise.all(cleanup).then(() => {});
    this.ownerRemovals.set(ownerKey, task);
    const finished = () => {
      if (this.ownerRemovals.get(ownerKey) === task) this.ownerRemovals.delete(ownerKey);
    };
    void task.then(finished, finished);
    return task;
  }

  private async stopIfUntrusted(record: R): Promise<void> {
    const key = quoteWatchKey(record);
    const trusted = await this.options.isTrustedMint(record.mintUrl);
    if (!trusted && !this.options.interests.hasRecovery(key) && this.isCurrent(record))
      await this.stopWatching(key);
  }
}
