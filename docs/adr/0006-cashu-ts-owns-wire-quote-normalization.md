# cashu-ts owns wire quote normalization

Status: accepted

Coco relies on cashu-ts v5 `Mint` and `Wallet` APIs to normalize raw mint quote responses from
mints, including legacy quote accounting derivation. Coco does not duplicate that wire-level
normalization in `MintAdapter`; instead, Coco owns canonical quote persistence, merge rules, stale
observation handling, and operation advancement from normalized quote snapshots.

When an incoming Quote Observation has a lower remote update timestamp than the canonical quote row,
Coco treats it as stale, ignores it for canonical quote fields, and emits no quote-updated event.
When the incoming and canonical remote update timestamps are equal but the accounting differs, Coco
treats the observation as invalid or stale, keeps the canonical row unchanged, and logs a warning.
When either side lacks a remote update timestamp, Coco falls back to comparing
`amountPaid + amountIssued` as a freshness marker. Coco accepts the observation only when that sum
increases without decreasing either accounting component. Out-of-spec accounting observations are
ignored non-destructively: Coco keeps the canonical row unchanged, emits no quote-updated event, and
logs a warning rather than breaking watcher or refresh paths.
Coco may persist a newer remote update timestamp when quote accounting and other meaningful quote
fields are unchanged, but timestamp-only freshness changes do not emit quote-updated events.
Coco may keep legacy method-specific mint quote state for compatibility, especially for BOLT11, but
mint quote behavior is driven by canonical Mint Quote Accounting rather than that state.
BOLT11 remains atomic in Coco's built-in behavior: minting from a BOLT11 quote is all-or-nothing for
the quote amount, even though readiness is derived from accounting rather than legacy state.
For reusable quotes, Coco preserves the existing local reservation model: effective local
availability subtracts in-flight Mint Quote Reservations, inferred from executing operations, and
also treats finalized local operations as issued if the mint's remote accounting has not caught up.
BOLT11 uses Mint Quote Accounting for readiness and stale protection, but it does not participate in
reusable quote reservation math because Coco treats BOLT11 mint quotes as atomic.
Coco exposes Remote Quote Update Time on canonical quote objects. Storage migrations backfill
accounting from legacy BOLT11 state when possible, preserve reusable quote accounting, and leave
Remote Quote Update Time unset because local row timestamps are not mint-reported timestamps.
Coco keeps the public BOLT11 mint quote `state` field for compatibility, marks it deprecated in
JSDoc, and avoids using it to drive mint quote behavior.
Canonical mint quote accounting fields live on the shared mint quote shape rather than inside
method-specific `quoteData`; `quoteData` is reserved for method-specific facts.
Repositories store `amountPaid`, `amountIssued`, and `remoteUpdatedAt` as first-class canonical
quote columns rather than inside method-specific JSON.
Mint quote persistence migrates away from `lastObservedRemoteState` and
`lastObservedRemoteStateAt`; those concepts belong to the old mint state model and do not apply to
melt quote state semantics.
This change does not add change-reason metadata to quote update events; event payloads continue to
carry the canonical quote, and consumers can inspect that quote if they need details.
The refactor is a public type-level breaking change because canonical mint quotes gain required
accounting fields and nullable Remote Quote Update Time. Runtime create, check, and import paths
remain compatible by deriving or normalizing legacy BOLT11 data where possible.
For explicit quote imports, Coco accepts legacy BOLT11 snapshots with `state` and `amount`, derives
canonical accounting from them, and persists the normalized canonical quote shape.
Coco also derives the deprecated public BOLT11 `state` field from accounting when a BOLT11 snapshot
has accounting but omits state, so compatibility consumers continue to receive a populated state.
Coco rejects explicitly imported mint quote accounting where issued amount exceeds paid amount. For
background Quote Observations, Coco treats that accounting as invalid, keeps the canonical row
unchanged, emits no quote-updated event, and logs a warning.
Coco persists the canonical quote method from its own route or handler context. Remote or imported
snapshots that report a conflicting method are invalid and must not be persisted under the requested
method.
Coco keeps separate local and remote update times: `updatedAt` is the local canonical row update
time in milliseconds, while `remoteUpdatedAt` is the mint-reported Remote Quote Update Time in
seconds. `remoteUpdatedAt` is nullable because legacy mints cannot provide or derive it.
