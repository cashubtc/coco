# PROTOTYPE — controllable CDK payment processor

This throwaway prototype answers one question:

> Can Coco mint and melt through a real CDK mint while a separate gRPC payment processor
> deterministically controls whether fake payments settle?

Run it from the repository root:

```sh
bun run prototype:cdk-payment-processor
```

The command downloads the pinned `cdk-mintd` `v0.17.0-rc.0` static binary and its matching
payment-processor proto into a temporary directory. It then starts an in-memory gRPC processor,
runs mintd with `ln_backend = "grpcprocessor"`, and uses Coco with memory repositories to:

1. create an unpaid mint quote;
2. settle its incoming payment through the processor;
3. mint real CDK signatures;
4. create a melt quote;
5. hold the outgoing payment pending;
6. settle it through the processor and finalize the Coco melt operation.

All payment state and CDK files are temporary. No real payment network is used.

The prototype intentionally does not include the HTTP/WebSocket fault proxy. Its purpose is to
validate the payment-control seam before adding the independent transport-control seam.

## Verdict

Validated against the pinned CDK `v0.17.0-rc.0` release:

- mintd connected to the processor using payment-processor protocol `3.0.0`;
- Coco observed an initially unpaid quote and its controlled settlement;
- Coco minted 100 sats backed by real CDK signatures;
- the processor held a 20-sat outgoing payment pending until explicitly settled;
- Coco finalized the melt with the processor's configured 1-sat fee.

Two implementation details matter for permanent infrastructure:

1. The pinned mintd requires `http://` in `grpc_processor.addr`, despite its example/default using
   a bare host.
2. CDK parses and re-serializes outgoing BOLT11 invoices before forwarding them. A processor must
   parse the forwarded invoice and correlate with its payment identifier or mint quote ID; it
   cannot depend on byte-for-byte invoice equality.
