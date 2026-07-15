# PROTOTYPE — Mint Batch failure recovery

This throwaway simulator asks whether the proposed Mint Issuance Attempt state model produces the
right member outcomes after confirmed rejection, an ambiguous response, quote-state
reconciliation, or exact-output recovery. It deliberately contains no production integration or
persistence.

Run it from the repository root:

```sh
bun run prototype:mint-batch-recovery
```

Drive one outcome at a time and inspect the complete attempt, member, proof, and dispatch state
after every transition.
