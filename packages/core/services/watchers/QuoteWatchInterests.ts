import { normalizeMintUrl } from '../../utils.ts';

/** Owners share observation without sharing each other's subscription lifetime. */
export type QuoteWatchOwner =
  | { kind: 'canonical'; id: string }
  | { kind: 'operation'; id: string }
  | { kind: 'mint-swap'; id: string; recovery: boolean };

export interface QuoteWatchIdentity {
  mintUrl: string;
  method: 'bolt11' | 'bolt12' | 'onchain';
  quoteId: string;
}

export interface QuoteWatchInterest extends QuoteWatchIdentity {
  owner: QuoteWatchOwner;
}

export interface QuoteInterestRegistrar {
  /** Accept local ownership synchronously; the watcher owns activation and setup diagnostics. */
  registerInterest(interest: QuoteWatchInterest): void;
  /** Withdraw ownership synchronously, then wait for the cleanup that withdrawal requires. */
  removeInterest(owner: QuoteWatchOwner): Promise<void>;
}

export function quoteWatchKey(quote: QuoteWatchIdentity): string {
  return `${normalizeMintUrl(quote.mintUrl)}::${quote.method}::${quote.quoteId}`;
}

export const canonicalQuoteOwner: QuoteWatchOwner = { kind: 'canonical', id: 'canonical' };

/** Logical interests survive transport completion until their owner releases them. */
export class QuoteWatchInterests {
  private readonly byQuote = new Map<string, Map<string, QuoteWatchOwner>>();

  private ownerKey(owner: QuoteWatchOwner): string {
    return `${owner.kind}:${owner.id}`;
  }

  add(key: string, owner: QuoteWatchOwner): void {
    let owners = this.byQuote.get(key);
    if (!owners) this.byQuote.set(key, (owners = new Map()));
    owners.set(this.ownerKey(owner), owner);
  }

  remove(key: string, owner: QuoteWatchOwner): void {
    const owners = this.byQuote.get(key);
    owners?.delete(this.ownerKey(owner));
    if (!owners?.size) this.byQuote.delete(key);
  }

  keysFor(owner: QuoteWatchOwner): string[] {
    return [...this.byQuote]
      .filter(([, owners]) => owners.has(this.ownerKey(owner)))
      .map(([key]) => key);
  }

  hasAny(key: string): boolean {
    return this.byQuote.has(key);
  }

  owners(key: string): QuoteWatchOwner[] {
    return [...(this.byQuote.get(key)?.values() ?? [])];
  }

  hasRecovery(key: string): boolean {
    return [...(this.byQuote.get(key)?.values() ?? [])].some(
      (owner) => owner.kind === 'mint-swap' && owner.recovery,
    );
  }

  clear(): void {
    this.byQuote.clear();
  }
}
