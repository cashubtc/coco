# `@cashu/coco-test-mint`

> [!WARNING]
> This package is experimental, private, and not covered by Coco's compatibility guarantees.

`@cashu/coco-test-mint` starts a real CDK mint whose BOLT11 payments are controlled by the test
process. CDK continues to own Cashu quote state, storage, signatures, issuance, proof state, and
WebSocket notifications; the package only replaces the payment rail with an in-memory gRPC
processor.

No Lightning node, Docker daemon, or real money is required. Starting the mint currently requires
network access to download the pinned CDK mintd binary and matching payment-processor protocol.

## Usage

```ts
import { ExperimentalTestMint } from '@cashu/coco-test-mint';

const mint = await ExperimentalTestMint.start();

try {
  const quote = await wallet.createMintQuoteBolt11(100);
  await mint.payments.settleIncoming({ request: quote.request });

  const invoice = mint.payments.createOutgoingInvoice({ amount: 20 });
  // Submit the invoice to the mint through Coco, leaving its melt call pending.
  const payment = await mint.payments.waitForOutgoing();
  await mint.payments.succeedOutgoing({ quoteId: payment.quoteId });
} finally {
  await mint.stop();
}
```

The initial interface deliberately supports only amountful BOLT11 payments:

- create valid fake outgoing invoices;
- settle incoming payments by their payment request;
- wait for an outgoing payment to reach the processor;
- complete outgoing payments with a deterministic one-satoshi fee;
- inspect snapshots of processor state.

HTTP and WebSocket fault injection, additional payment methods, failure outcomes, persistent binary
caching, and a remote control interface are intentionally deferred.

## Smoke test

From the repository root:

```sh
bun run test-mint:smoke
```

The smoke flow uses Coco with memory repositories to mint 100 sats, hold a 20-sat melt pending,
settle it through the processor, and verify the final 79-sat balance.
