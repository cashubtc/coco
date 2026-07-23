import { createFakeInvoice } from 'fake-bolt11';

export function createAmountfulInvoice(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new TypeError('BOLT11 invoice amount must be a positive integer');
  }
  return createFakeInvoice(amount);
}

export function getBolt11AmountSats(invoice: string): number {
  const match = /^ln(?:bc|tb|bcrt|tbs)(\d+)([munp]?)1/i.exec(invoice);
  if (!match) throw new Error('Only amountful BOLT11 invoices are supported');

  const amount = Number(match[1]);
  const multiplier = match[2]?.toLowerCase();
  const satsPerUnit =
    multiplier === 'm'
      ? 100_000
      : multiplier === 'u'
        ? 100
        : multiplier === 'n'
          ? 0.1
          : multiplier === 'p'
            ? 0.0001
            : 100_000_000;
  const sats = amount * satsPerUnit;
  if (!Number.isSafeInteger(sats)) {
    throw new Error(`BOLT11 invoice amount is not a whole satoshi: ${sats}`);
  }
  return sats;
}
