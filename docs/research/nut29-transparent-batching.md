# NUT-29 constraints for transparent batching

Research for [Establish the NUT-29 and cashu-ts constraints for transparent
batching](https://github.com/cashubtc/coco/issues/324), based on NUT-29 at
[`0f1caff`](https://github.com/cashubtc/nuts/blob/0f1caff5d56bf0b315dded0cf0b88bbf0fd90676/29.md),
cashu-ts
[`v4.6.1`](https://github.com/cashubtc/cashu-ts/tree/69bc8d97467624d8fc9c521b449757e21415ce85),
and Coco at
[`67d112b`](https://github.com/cashubtc/coco/tree/67d112bb7ceaf0854890487679bb676143ad49e9).

## Decision-ready answer

Transparent batching can preserve Coco's per-operation behavior if it is treated as an internal,
recoverable transport attempt rather than a new user-visible operation:

- Gate batching on the mint advertising `nuts["29"]`. If `methods` is present, use only listed
  methods; when it is absent, NUT-29 declares every NUT-04 mint method batch-capable. Unsupported
  mints continue through existing single-quote calls.
- Group quote checks by mint and method. Group redemption more narrowly by mint, method, and unit.
  A batch-mint endpoint is method-specific, and the mint must reject mixed methods or units. A
  cashu-ts `Wallet` is also bound to one unit. Keyset is not a protocol grouping constraint, but it
  is a practical cashu-ts helper constraint; see below.
- Deduplicate quote IDs. Preserve request order so check responses, `quote_amounts`, NUT-20
  signatures, and output/signature ranges can be correlated deterministically.
- Chunk by `min(advertised max_batch_size, 100)`. cashu-ts imposes an absolute 100-quote cap. When
  NUT-29 omits `max_batch_size`, the mint's limit is implementation-defined and clients must handle
  error `11017`; a rejected chunk therefore needs splitting or single-call fallback.
- Batch checking is all-or-nothing for unknown or malformed quote IDs. A deterministic batch-check
  rejection may be split so healthy quotes still advance independently. Validate response length,
  order, IDs, methods, and units before applying any local quote updates.
- For first-scope, fixed-amount BOLT11 redemption, send each quote's full expected amount in
  `quote_amounts` and require total output value to equal their sum. The field is optional in the
  protocol for BOLT11 but required by cashu-ts's `BatchMintRequest`, so always including it is the
  compatible choice.
- Reuse and concatenate the already-persisted output data of eligible operations in a stable order.
  The response signatures correspond to outputs, in output order, so known per-operation ranges can
  be unblinded and attributed back to the original operation. Do not generate a fresh consolidated
  output set merely to batch: that would abandon the operations' recovery material and consume new
  deterministic counters.
- Exclude NUT-20-locked quotes unless Coco adds the missing signing-key path. If any quote is locked,
  `signatures` must have one entry per quote (`null` for unlocked quotes), and every locked quote's
  signature covers its quote ID plus the complete consolidated output array. One invalid signature
  rejects the entire batch. Current Coco BOLT11 execution passes no private key.
- A confirmed protocol validation error means no quote was minted and is safe to split/fallback.
  A timeout, disconnect, malformed success response, or server failure is ambiguous: do not retry
  individual quotes or create new outputs. Keep every member in recovery, check quote accounting,
  and restore the exact blinded outputs through NUT-09. NUT-29 specifies atomic validation but no
  idempotency key or retry protocol.

This yields the required observable contract: batching changes network-call shape, while each quote
still reaches its own result. A bad quote can delay its peers for one attempt, but after a proven
all-or-nothing rejection the coordinator can isolate it and continue the others.

## Protocol constraints

### Discovery and size

NUT-29 is optional. The NUT-06 info object is:

```json
{
  "nuts": {
    "29": {
      "max_batch_size": 100,
      "methods": ["bolt11", "bolt12"]
    }
  }
}
```

Both members are optional. An omitted `methods` means all NUT-04 methods, not no methods. An omitted
`max_batch_size` means an undisclosed implementation limit; error `11017` is the specified signal
that a request exceeded it. The wording describes the maximum quote count in a single batch request,
so the safe design is to apply it to both check and mint chunks.

### Batch check

`POST /v1/mint/quote/{method}/check` accepts `{ "quotes": string[] }`. IDs must be unique. The
response is an array of method-specific NUT-04 quote objects in exactly the request order. If any ID
is unknown or malformed, the mint rejects the entire request. The endpoint does not require quotes
to share a unit, although later redemption does, so quote checking can group by mint and method and
route each returned quote by its own unit.

Current NUT-04 responses include `amount_paid`, `amount_issued`, and monotonic `updated_at`. A wallet
must not overwrite newer accounting data with an older response or decrease the stored paid/issued
amounts. Coco's first-scope non-reusable BOLT11 state remains `UNPAID`, `PAID`, or `ISSUED`, but the
batch parser should not discard the protocol's accounting/ordering guarantees.

### Batch mint

`POST /v1/mint/{method}/batch` accepts unique `quotes`, optional ordered `quote_amounts`, one
consolidated `outputs` array, and optional ordered NUT-20 `signatures`. Required validation includes:

1. non-empty and unique quotes (`11016` for duplicates);
2. known IDs, one URL method, and one currency unit;
3. mintable quote state (`PAID` for fixed BOLT11; reusable methods may have remaining balance);
4. balanced value (BOLT11 outputs equal the quote-amount sum; reusable methods may mint less);
5. valid NUT-20 signature-array shape and signatures; and
6. any mint-specific size limit (`11017` when exceeded).

If validation fails, the mint must reject the entire request without minting any quote. A successful
response contains one blind signature for every output, in output order. NUT-29 does not partition
outputs or proofs by quote; that mapping remains wallet-local.

## cashu-ts 4.6.1

### Available

- Public `Nut29Info` and `BatchMintRequest` types.
- `Mint.mintBatch(method, payload)`, plus BOLT11/BOLT12 wrappers. The method validates the method
  token, serializes `quote_amounts`, uses the normal authenticated/custom request path, validates a
  signatures-array response, and normalizes signature amounts.
- `Wallet.prepareBatchMint()` creates consolidated outputs, reserves deterministic counters in one
  `CounterSource` call, creates full-output NUT-20 signatures, applies the advertised size limit,
  and enforces cashu-ts's hard limit of 100.
- `Wallet.completeBatchMint()` makes the request, checks the signature count, validates signatures
  (including configured DLEQ requirements), and returns the combined proofs.
- Mint-info normalization and `MintInfo.isSupported(29)` when using cashu-ts's lazy `MintInfo`
  object. Coco's persisted mint info is the normalized plain NUT-06 response, so Coco can inspect
  `mintInfo.nuts["29"]` directly.

### Missing or unsafe to rely on

- There is no batch quote-check request type or `Mint.checkMintQuoteBatch()` helper. Only single
  `GET /v1/mint/quote/{method}/{quote}` is available. A Coco implementation therefore needs a
  library addition/upgrade or an adapter-level POST with equivalent JSON-integer parsing,
  method-specific normalization, rate limiting, and NUT-21/22 authentication.
- cashu-ts's method-specific quote normalizer is private. A raw batch-check implementation must
  explicitly normalize BOLT11 `amount` and `expiry` (and reusable-method accounting amounts). The
  pinned BOLT11 response type also predates current NUT-04's `amount_paid`, `amount_issued`, and
  `updated_at` fields.
- `prepareBatchMint()` is not a capability gate: it permits batching when NUT-29 is absent and only
  warns when the advertised method list excludes the requested method. Coco must decide support
  before calling it.
- Despite its JSDoc telling callers to check `PAID`, `prepareBatchMint()` only validates quote unit
  and expiry. It does not fetch/check state, reject duplicate quote IDs, recover errors, split
  batches, or preserve per-quote outcomes.
- `BatchMintRequest.quote_amounts` is mandatory in the TypeScript type even though NUT-29 makes it
  optional for BOLT11. `prepareBatchMint()` always fills it, which is suitable here.
- `BatchMintPreview` owns one `keysetId` and `completeBatchMint()` unblinds all outputs using that
  keyset, then returns one combined proof array. It does not accept already-prepared per-operation
  output groups or return per-quote ranges. Coco can either group by keyset and construct a preview
  carefully, or use `Mint.mintBatch()` plus Coco's existing per-operation output/unblinding path.
- There is no automatic retry, ambiguity reconciliation, NUT-09 recovery, or durable batch-attempt
  record in these helpers.

## Relevant Coco constraints

- Every pending mint operation already has one quote ID and persisted deterministic `outputData`.
  BOLT11 prepare allocates that data before payment settlement, and existing execution/recovery can
  restore exact outputs. This is the right material to concatenate for a transport batch.
- `MintAdapter` exposes single `checkMintQuote()` but neither batch check nor batch mint. Its cached
  cashu-ts `Mint` instances carry the request provider and optional auth provider, so new endpoints
  must preserve that path.
- The watcher already groups WebSocket subscriptions by mint/subscription kind and chunks 100, but
  pending-operation recovery and handler checks still use single quote-check calls.
- The processor currently removes and finalizes one ready queue item per pass. Transparent batching
  must drain compatible ready items together, while explicit calls coordinate with that same
  execution path.
- Recovery currently transitions an operation to `executing`, checks its quote after failure, and
  restores its persisted outputs when remotely issued. A batched attempt must transition/persist all
  members before the POST and retain the per-operation output ranges until all members resolve.
- Coco's repository-backed counter increment is read-then-write, not an atomic range reservation.
  Concatenating outputs that were already prepared under Coco's mint-scoped preparation lock avoids
  introducing a second allocation race. Generating new batch outputs would require a separate
  counter/storage design decision.

## Requirements the specification should carry forward

1. Capability-gated, per-mint fallback to existing calls.
2. Check grouping by mint/method; redemption grouping by mint/method/unit and, if using the high-level
   cashu-ts completion helper, keyset.
3. Unique ordered IDs, stable output concatenation/ranges, and strict response validation.
4. A 100-quote wallet ceiling, advertised-limit chunking, and graceful `11017` downshifting.
5. Split/fallback only after an unambiguous atomic rejection; recovery-first handling after an
   ambiguous transport/result failure.
6. Exact-output NUT-09 recovery and no new deterministic outputs during retry.
7. Explicit exclusion or implementation of NUT-20 locked-quote signing.
8. Batch-check normalization/authentication that matches existing single-check behavior.
9. Tests for one bad check ID, one bad redemption quote, ordering, size limits, response loss after
   issuance, restore, mixed unit/method exclusion, and independent final operation outcomes.

## Primary sources

- [NUT-29 at the researched commit](https://github.com/cashubtc/nuts/blob/0f1caff5d56bf0b315dded0cf0b88bbf0fd90676/29.md)
- [NUT-04 quote accounting and execution](https://github.com/cashubtc/nuts/blob/0f1caff5d56bf0b315dded0cf0b88bbf0fd90676/04.md)
- [NUT error codes](https://github.com/cashubtc/nuts/blob/0f1caff5d56bf0b315dded0cf0b88bbf0fd90676/error_codes.md)
- [NUT-09 exact-output recovery](https://github.com/cashubtc/nuts/blob/0f1caff5d56bf0b315dded0cf0b88bbf0fd90676/09.md)
- [cashu-ts NUT-29 types](https://github.com/cashubtc/cashu-ts/blob/69bc8d97467624d8fc9c521b449757e21415ce85/src/model/types/NUT29.ts)
- [cashu-ts low-level Mint API](https://github.com/cashubtc/cashu-ts/blob/69bc8d97467624d8fc9c521b449757e21415ce85/src/mint/Mint.ts)
- [cashu-ts Wallet batch helpers](https://github.com/cashubtc/cashu-ts/blob/69bc8d97467624d8fc9c521b449757e21415ce85/src/wallet/Wallet.ts)
- [Coco MintAdapter](https://github.com/cashubtc/coco/blob/67d112bb7ceaf0854890487679bb676143ad49e9/packages/core/infra/MintAdapter.ts)
- [Coco BOLT11 mint handler](https://github.com/cashubtc/coco/blob/67d112bb7ceaf0854890487679bb676143ad49e9/packages/core/infra/handlers/mint/MintBolt11Handler.ts)
- [Coco mint processor](https://github.com/cashubtc/coco/blob/67d112bb7ceaf0854890487679bb676143ad49e9/packages/core/services/watchers/MintOperationProcessor.ts)
