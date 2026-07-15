# PROTOTYPE — Mint Batch output ownership

This throwaway logic prototype asks whether Mint Operations should create and own outputs during
preparation, or whether a persisted dispatch attempt should create and own outputs when it knows
the complete amount being minted. The batch-owned model coalesces 100 quotes of 21 sat into four
outputs for 2,100 sat instead of concatenating 300 per-operation outputs.

The prototype deliberately moves output allocation rather than allocating twice. A gap of 300
unused deterministic counters before four real outputs can cross NUT-13's recommended stop point
of three empty 100-counter restore batches.

Run it from the repository root:

```sh
bun run prototype:mint-batch-outputs
```

Build the same 100-operation batch under both ownership models. The useful comparison is the proof
count, allocation timing, counter value, recovery owner, and whether outcomes remain visible on
each Mint Operation even when the resulting proofs belong to the dispatch attempt.
