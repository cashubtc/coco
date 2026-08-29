# cashu-ts RC upgrade assessment (`5.0.0-rc.4` → `5.0.0-rc.7`)

Research date: 2026-08-28

## Executive summary

The latest published `@cashu/cashu-ts` release candidate is `5.0.0-rc.7`; npm's
`next` tag points to it, while npm's stable `latest` tag remains `4.9.0`.
Coco pins `5.0.0-rc.4` in seven workspace package manifests and `bun.lock`.

The dependency bump is not source-compatible as-is. The agreed upgrade feature has
three workstreams:

1. Convert every positional `new PaymentRequest(...)` call to the new options-object
   constructor (38 production/test call sites in six files). Preserve all request fields when
   cloning, but reject rc.7 payment-request features that Coco does not yet implement.
2. Integrate rc.7's rotation errors with Coco's persisted operation state machine.
   A `StaleKeysetError` means cashu-ts may have refreshed its in-memory keychain, but
   it deliberately does not retry output operations. Persisted `OutputData` made for
   the old keyset must not simply be replayed; Coco fails the current operation and the
   caller prepares a new one.
3. Adopt rc.5's rotating proof selector and cover stricter quote validation and other changed
   runtime boundaries with regression tests.

There are also intentional behavior changes to proof selection, active-keyset choice,
quote validation, and malformed-input handling that warrant regression tests. The
remaining public API changes either do not affect current Coco call sites or are useful
quality-of-life replacements for Coco's local helpers.

## Agreed feature boundary

The rc.7 upgrade deliberately does **not** implement the new NUT-18 payment-request semantics.
That work belongs in a dedicated follow-up PR implementing ADR-0014.

This feature includes only the payment-request changes needed to compile and fail safely:

- migrate positional `PaymentRequest` constructors to the rc.7 options object;
- preserve `mintsPreferred` and `supportedMethods` when reconstructing a decoded request;
- reject requests with `mintsPreferred === true` or non-empty `supportedMethods` during parsing,
  before exposing `payableMints` or allowing preparation;
- retain Coco's existing strict mint-list matching, gross-amount send/receive accounting, and
  `payableMints` API for otherwise legacy-compatible requests.

The follow-up PR owns advisory mint selection, accepted melt methods, method fees, net-after-input-
fee settlement, structured payment candidates, receiver request expansion, and related API and
history changes. Until that PR lands, Coco-to-Coco legacy requests remain supported, but broader
rc.7 NUT-18 interoperability is intentionally incomplete.

## Version and source evidence

### Installed version

**Fact.** Coco uses the exact version `5.0.0-rc.4` in:

- [`packages/core/package.json`](../../packages/core/package.json)
- [`packages/adapter-tests/package.json`](../../packages/adapter-tests/package.json)
- [`packages/indexeddb/package.json`](../../packages/indexeddb/package.json)
- [`packages/expo-sqlite/package.json`](../../packages/expo-sqlite/package.json)
- [`packages/sqlite3/package.json`](../../packages/sqlite3/package.json)
- [`packages/sqlite-bun/package.json`](../../packages/sqlite-bun/package.json)
- [`packages/sql-storage/package.json`](../../packages/sql-storage/package.json)
- [`bun.lock`](../../bun.lock), which resolves the direct dependency to rc.4

`bun.lock` also contains `cashu-ts@3.7.1` transitively under `npubcash-sdk`; that is a
separate dependency instance and is not part of this direct rc.4 → rc.7 upgrade.

### Target version

**Fact.** Official npm metadata lists `5.0.0-rc.7` as the newest prerelease and maps
the `next` dist-tag to it. It was published on 2026-08-16. The package tarball integrity
is `sha512-MAleg1lAZiVxiYiWQoMKj/Cmn77+/ZFRnAxTELWLVuN3reAqE7CyYGz1e8kwWYLyn2XA/s/5pQh8GXy5gg/98w==`.
See the [official npm version page](https://www.npmjs.com/package/@cashu/cashu-ts/v/5.0.0-rc.7)
and [registry metadata](https://registry.npmjs.org/@cashu%2fcashu-ts).

The upstream comparison contains 83 commits across rc.5, rc.6, and rc.7:
[official rc.4…rc.7 comparison](https://github.com/cashubtc/cashu-ts/compare/v5.0.0-rc.4...v5.0.0-rc.7).
The authoritative release notes are [rc.5](https://github.com/cashubtc/cashu-ts/releases/tag/v5.0.0-rc.5),
[rc.6](https://github.com/cashubtc/cashu-ts/releases/tag/v5.0.0-rc.6), and
[rc.7](https://github.com/cashubtc/cashu-ts/releases/tag/v5.0.0-rc.7).

## Necessary Coco changes

### 1. Update all direct pins and regenerate the lockfile

**Fact.** All seven direct manifests use exact pins rather than a range.

**Required change.** Change all seven to `5.0.0-rc.7`, run `bun install`, and commit
the resulting `bun.lock`. Do not alter the nested `npubcash-sdk` resolution manually.
Validate every workspace because the dependency is also used by adapter contract tests.

### 2. Migrate `PaymentRequest` construction

**Upstream fact.** rc.5 replaces the positional constructor with
`new PaymentRequest(options?: PaymentRequestOptions)`. A positional call no longer
type-checks. The options include the new `mintsPreferred` and `supportedMethods`
fields. `singleUse` is now tri-state (`true`, `false`, or absent) instead of defaulting
to `false`. See [PR #683](https://github.com/cashubtc/cashu-ts/pull/683) and the
[pinned migration guide](https://github.com/cashubtc/cashu-ts/blob/v5.0.0-rc.7/migration-5.0.0.md#paymentrequest-constructor-takes-an-options-object).

**Coco fact.** There are 38 constructor calls in six files. The production calls are in
[`PaymentRequestReceiveService.ts`](../../packages/core/services/PaymentRequestReceiveService.ts)
and [`PaymentRequestService.ts`](../../packages/core/services/PaymentRequestService.ts).
The rest are in core unit tests and adapter integration tests.

A production typecheck against rc.7 was also run in a temporary dependency setup. It
reported exactly two production errors: the positional constructors at
`PaymentRequestReceiveService.ts:161` and `PaymentRequestService.ts:532`. Converting those
to options objects, including `mintsPreferred` and `supportedMethods` when cloning, made
the production typecheck clean. Tests and adapter fixtures still contain the remaining
positional calls and must be migrated before the full suite/build is clean.

**Required compatibility change.** Convert calls to this shape:

```ts
new PaymentRequest({
  transport,
  id,
  amount,
  unit,
  mints,
  description,
  singleUse,
  nut10,
  mintsPreferred,
  supportedMethods,
});
```

When `PaymentRequestService.resolvePreparedRequest` substitutes a payer-selected amount,
it must copy `mintsPreferred` and `supportedMethods` as well as the old fields. Omitting
them would produce a valid request object with silently changed payment semantics.

Add an interim compatibility guard while parsing a request. Requests with
`mintsPreferred === true` or non-empty `supportedMethods` must fail with a structured
`PaymentRequestError` before Coco exposes `payableMints` or permits preparation. Explicit
`mintsPreferred === false` remains compatible with Coco's existing strict-list behavior.

No strict equality check against `singleUse === false` was found; Coco's existing falsy
checks already treat absent and explicit `false` alike. Tests should nevertheless cover
an absent flag round-trip.

### 3. Deferred follow-up: correct NUT-18 payer semantics

**Feature status.** This section is research for the dedicated payment-request PR and is excluded
from the rc.7 upgrade feature.

**Upstream fact.** rc.5 aligns payment requests with the current NUT-18 model:

- A mint list is strict by default. `mintsPreferred === true` (`mp=true` on the wire)
  makes it advisory.
- `supportedMethods` (`sm`) lists acceptable melt methods. Each method may include a
  fee (`mf`) that compensates the receiver for melting from an unlisted mint.
- Payments from a listed mint do not add `mf`; payments from an unlisted/advisory mint
  add the lowest applicable fee among methods the payer's mint supports.
- The requested amount is always net of the sent proofs' input fees.
- `wallet.ops.sendToRequest(...)` enforces the strict-list, unit, NUT-05 method,
  applicable `mf`, NUT-10 lock, and net-of-input-fees rules together.

See [PR #683](https://github.com/cashubtc/cashu-ts/pull/683),
[PR #787](https://github.com/cashubtc/cashu-ts/pull/787), and the
[rc.7 payment-request guide](https://github.com/cashubtc/cashu-ts/blob/v5.0.0-rc.7/docs-src/usage/payment_requests.md).

**Coco fact.** [`PaymentRequestService`](../../packages/core/services/PaymentRequestService.ts):

- rejects any mint outside `paymentRequest.mints`, even for an advisory list;
- filters `payableMints` with raw `mints.includes(mintUrl)`;
- ignores `supportedMethods` and `mf`;
- initializes the send for only the requested amount.

[`DefaultSendHandler`](../../packages/core/infra/handlers/send/DefaultSendHandler.ts)
uses `includeFees` to cover the payer's swap inputs, but creates send outputs totalling
exactly the requested amount. The receiver therefore nets less than requested when
those output proofs carry an input fee. This is not the NUT-18 `includeFees(true)`
behavior implemented by cashu-ts's `SendBuilder`.

**Required change.** Before creating the durable send operation:

1. Use `pr.isMintListStrict` and `pr.includesMint(mintUrl)` rather than raw list
   membership.
2. Resolve the mint's NUT-05 methods for the request unit and reject it if none matches
   `pr.supportedMethods`.
3. Add the applicable `pr.feesFor(mintUrl, meltMethods)`.
4. Add enough value for the receiver to pay input fees on the resulting send proofs.
   `wallet.getFeesToInclude(amount, { nOutputs })` is the new low-level helper; the
   one-step upstream reference behavior is `wallet.ops.sendToRequest`.
5. Preserve the distinction between the requested/net amount and the gross token amount
   in Coco's operation model, logs, history, and API result.

Because Coco persists prepared operations and custom output data, using
`wallet.ops.sendToRequest(...).run()` directly would bypass its saga. The practical
approach is to reuse the new cashu-ts policy helpers while keeping Coco's prepare/execute
boundaries, or explicitly port the same checks into the operation preparation step.

### 4. Deferred follow-up: correct NUT-18 receiver settlement validation

**Feature status.** This section is research for the dedicated payment-request PR and is excluded
from the rc.7 upgrade feature.

**Upstream fact.** `wallet.isPaymentRequestSatisfied(pr, proofs, expectedAmount?)`
checks:

```text
sum(proofs) - input fees >= requested amount + applicable method fee
```

It also rejects duplicate proof secrets and proofs outside the wallet's unit. The
method now requires `id`, `amount`, and `secret` for each proof. See
[PR #787](https://github.com/cashubtc/cashu-ts/pull/787) and the later duplicate-proof
fix in [PR #916](https://github.com/cashubtc/cashu-ts/pull/916).

**Coco fact.** `PaymentRequestReceiveService.validatePayload` currently accepts when
the **gross** proof sum is at least `operation.amount`. Only after creating the child
receive operation does Coco calculate its input fee and net amount. An underfunded
payment can therefore be accepted and finalized.

**Required change.** Reconstruct/persist the full `PaymentRequest` terms for a receive
operation, then validate settlement against full proofs and wallet keyset fees before
finalization. Prefer `wallet.isPaymentRequestSatisfied`; otherwise reproduce its
formula, duplicate-secret check, unit-keyset check, and applicable `mf` calculation.

If Coco exposes receiver-side creation of advisory mint lists or accepted melt methods,
extend `CreatePaymentRequestReceiveInput`, the operation model, repositories, migrations,
and encoded-request round trips with `mintsPreferred` and `supportedMethods`. If that UI
surface is intentionally deferred, Coco must still correctly parse and pay foreign
requests that carry these fields.

### 5. Integrate rotation-aware errors with durable operations

**Upstream fact.** In rc.7, a NUT-00 keyset rejection (`12001`, `12002`, or `12003`)
from `completeSwap`, `completeMint`, `completeBatchMint`, or `completeMelt` becomes a
`StaleKeysetError`. Its `cause` is the original `MintOperationError`; `repaired` reports
whether cashu-ts refreshed its keyset snapshot. cashu-ts deliberately does **not** retry:
the rejected outputs were built for the stale keyset and require a fresh prepare.

rc.7 also adds `UnknownKeysetError`, `MeltChangeError`, `ensureOperableKeysets`,
`strictCachedKeysets`, and a `wallet.on.keychainUpdated` event. Melt inputs are resolved
against the keyset snapshot; unknown on-chain melt keysets fail because their fees cannot
be priced. See [PR #978](https://github.com/cashubtc/cashu-ts/pull/978) and the
[rotation/error migration notes](https://github.com/cashubtc/cashu-ts/blob/v5.0.0-rc.7/migration-5.0.0.md#keyset-rejections-now-throw-stalekeyseterror).

**Coco fact.** Coco persists custom `OutputData` between prepare and execute in mint,
send, receive, and pre-melt-swap flows. Its receive rollback classifier recognizes only
`MintOperationError`, and [`models/Error.ts`](../../packages/core/models/Error.ts)
does not re-export the new keyset errors.

**Required change.** Audit every persisted-output path, not just receive:

- mint handlers (`mintProofs*`);
- default and P2PK sends (`wallet.send`);
- receive (`wallet.receive`);
- pre-melt swaps (`wallet.send`).

On `StaleKeysetError`, first use the existing quote/proof-state recovery checks to determine
whether the mint applied a side effect. Once the Exact Operation Request is proven unapplied, roll
the operation back, release its reservations, refresh the Known Mint through Coco, rebuild the
Wallet Instance, and surface a retryable stale-keyset failure. The caller must prepare a new
operation with a new Output Allocation. Coco does not mutate, automatically replace, or replay the
failed operation. If the outcome remains ambiguous, retain the operation's resources and do not
report it as safely retryable.

Retain access to the upstream `StaleKeysetError` cause where protocol codes and its `repaired`
diagnostic are needed. Coco exposes its own stable `StaleKeysetError`, including the failed
operation ID, only after synchronous rollback and Known Mint refresh succeed. If cleanup fails or
the outcome cannot be proven unapplied, return Coco's stable `OperationRecoveryRequiredError`,
including the operation ID, mint URL, unit, and cause, instead of inviting an immediate retry.
Route `UnknownKeysetError` and `MeltChangeError` through operation-specific
recovery because neither implies that a caller can safely retry from scratch; in particular, a
paid melt with missing change must not be restarted blindly.

Reuse the existing `failed` and `rolled_back` terminal states and error text rather than adding
states or repository fields. Mint operations can additionally use their existing structured
terminal-failure metadata. Serialize stale cleanup through Coco's shared mint lock, invalidate all
cached Wallet Instances for the mint, force one persisted mint/keyset refresh, and rebuild the
affected unit. If the refresh fails, persist that the Known Mint still requires refresh so its old
timestamp cannot make the snapshot appear fresh after restart.

For crash safety, persist that refresh requirement first, then prove and persist operation rollback
with resource release, then force the network refresh. Return the retryable Coco
`StaleKeysetError` only after every step succeeds. An interruption before that boundary leaves the
operation recoverable or the Known Mint durably invalidated.

For `MeltChangeError`, return normal finalized or pending results when melt recovery establishes
them; only an unresolved outcome is recovery-required. For `UnknownKeysetError`, force one refresh
and return `KeysetSyncError` if the keyset remains unknown, rolling back safely where the operation
state permits. Reuse existing operation events and add structured logs rather than introducing a
new public stale-keyset event.

Add tests for both `repaired: true` and `repaired: false`, a crash between rejection and safe
rollback, a rotation occurring between Coco prepare and execute, and a caller-created replacement
operation using a fresh Output Allocation.

### 6. Choose who owns the keyset cache, especially while BLS is blocked

**Upstream fact.** rc.7 follows keyset rotations by default, can refresh a keychain that
was initially loaded from cache, and emits `keychainUpdated`. Setting
`strictCachedKeysets: true` makes the application responsible for refreshing cached
keysets. See [PR #978](https://github.com/cashubtc/cashu-ts/pull/978).

**Coco fact.** [`MintService`](../../packages/core/services/MintService.ts) and
[`WalletService`](../../packages/core/services/WalletService.ts) own a persisted mint and
keyset cache. Coco deliberately filters BLS (`02…`) keysets because some of its direct proof
state lookups still use secp256k1-only `Y` derivation. A cashu-ts self-refresh is not
filtered through that policy, and the new `getCheapestKeyset` ordering prefers the newest
keyset version before fee.

**Recommended necessary decision.** Until Coco supports BLS end to end, construct its
wallets with `strictCachedKeysets: true`, catch the stale-keyset signal, refresh through
`MintService`, reapply Coco's keyset filter, clear/rebuild the wallet, and re-prepare the
operation. This keeps one authoritative cache and prevents a live wallet from silently
binding to a BLS keyset that the rest of Coco rejects.

The alternative is to accept cashu-ts's default repair, subscribe to `keychainUpdated`,
atomically merge its cache into Coco's repositories, and make the rest of Coco
curve-aware first. Merely allowing default repair without persistence creates temporary
in-memory/DB divergence and can restore the stale snapshot when a wallet is rebuilt.

### 7. Accept or opt out of the new proof-selection policy

**Upstream fact.** rc.5 changes the default from `selectProofsRGLI` to
`selectProofsRotating`. It spends legacy, older-version, and inactive keyset buckets
before fresher proofs, deliberately including uneconomic stale dust. Opt out by passing
`selectProofs: selectProofsRGLI` to `Wallet`. See
[PR #813](https://github.com/cashubtc/cashu-ts/pull/813).

**Coco fact.** `ProofService.selectProofsToSend` delegates to the wallet default. The
selected proof count, fee, reservations, and whether a send needs a swap may therefore
change.

**Required decision/test change.** Prefer accepting the rotation policy because it
reduces stale-keyset balances, but update selection, reservation, send, melt, and recovery
tests for the new inputs and one-off dust cost. If stable selection is more important for
the first upgrade PR, explicitly configure `selectProofsRGLI` and adopt rotation in a
separate behavior PR.

### 8. Update fixtures for stricter quote validation

**Upstream fact.** rc.6 checks BOLT11 mint quote amounts against the response and invoice;
it also prevents a BOLT11 melt quote from charging more than the invoice. Fake or
amountless invoice strings now fail the typed wallet helpers. Generic raw quote helpers
remain escape hatches. See [PR #925](https://github.com/cashubtc/cashu-ts/pull/925) and
the [migration guide quote sections](https://github.com/cashubtc/cashu-ts/blob/v5.0.0-rc.7/migration-5.0.0.md#bolt11-mint-quotes-are-checked-against-the-requested-amount).

**Coco impact (inference).** Production calls should need no logic change for conforming
mints. Integration/custom-request fixtures using strings such as `lnbc1test` may now fail
before reaching Coco assertions; replace them with parseable, amount-matching invoices or
mock above the cashu-ts validation boundary. Add negative tests for mismatched mint and
melt quotes.

## Quality-of-life changes worth adopting

These are not required to compile, but they remove duplicated policy from Coco and reduce
future drift. Payment-request-specific QoL changes are deferred with the NUT-18 follow-up; the
upgrade feature should not introduce them opportunistically.

1. **Deferred with payment requests: replace manual payment-method capability walking.**
   `MintInfo.getMintMeltMethod`
   works offline from a persisted `GetInfoResponse` and returns the matching method,
   limits, and options. Upstream explicitly identified Coco's duplicated NUT-04/NUT-05
   walking as motivation. Replace the hand-written parsing in `MintService` where its
   richer Coco error/result types permit. [PR #812](https://github.com/cashubtc/cashu-ts/pull/812)

2. **Deferred with payment requests: use `wallet.getFeesToInclude`.** It calculates the fee needed so new outputs can be
   spent without reducing the receiver's net amount. This should replace/adapt Coco's
   local fee-convergence logic and is directly useful for NUT-18. Upstream cites Coco's
   helper as motivation. [PR #846](https://github.com/cashubtc/cashu-ts/pull/846)

3. **Deferred: use the public strict URL normalizer.** cashu-ts now exports
   `normalizeMintUrl`, which rejects non-HTTP(S) URLs, credentials, query strings,
   fragments, and percent-encoded path characters. Coco's local helper silently strips
   some of these. Consolidation also makes `PaymentRequest.includesMint` comparisons
   consistent. Because that changes Coco's accepted input behavior independently of keyset
   rotation, adopt it later with focused migration tests.
   [PR #834](https://github.com/cashubtc/cashu-ts/pull/834)

4. **Deferred: use `PaymentRequest.builder()` for receiver-created requests.** It avoids positional
   mistakes and supports mint preference, accepted methods/fees, transports, and locks.
   [PR #780](https://github.com/cashubtc/cashu-ts/pull/780)

5. **Deferred: use payload helpers.** `PaymentRequest.encodePayload` serializes bigint amounts
   correctly and enforces a strict mint list; `PaymentRequest.decodePayload` performs
   strict shape validation. Coco's custom parser can retain its domain errors and hashing
   while delegating wire validation. [PR #853](https://github.com/cashubtc/cashu-ts/pull/853)

6. **Let normal wallet checks honor mint batch caps.** rc.7 reads NUT-06
   `max_array_length` for `checkProofsStates` and restore batches. Coco explicitly sets a
   restore batch of 100, so that override is unchanged; ordinary wallet state checks gain
   the advertised limit automatically. [PR #965](https://github.com/cashubtc/cashu-ts/pull/965)

7. **Persist keychain updates if/when default repair is enabled.** The
   `keychainUpdated` event gives Coco a supported point to synchronize cashu-ts's cache
   rather than polling internal state. [PR #978](https://github.com/cashubtc/cashu-ts/pull/978)

8. **Use the new errors for recovery UX.** `MeltChangeError` carries output data and the
   paid quote so change can be reconstructed; `UnknownKeysetError` explains whether a
   refresh was attempted. Coco's custom melt flow may not use them today, but re-exporting
   them keeps downstream callers from string-matching failures.

## Changes that need no current Coco code change

These conclusions are based on repository-wide call-site searches and should be retained
as upgrade-test assertions:

- `CounterSource.reserveAt` is now required and must atomically claim a manual counter
  range. Coco has no custom `CounterSource`; its own `OutputDataCreator`/counter service is
  separate. External implementations passed by consumers would need updating.
  [PR #923](https://github.com/cashubtc/cashu-ts/pull/923)
- `TokenMetadata.incompleteProofs` was replaced by `proofAmounts`. Coco only reads
  `mint`/`unit` from `getTokenMetadata`, so no current call site uses the removed field.
  [PR #941](https://github.com/cashubtc/cashu-ts/pull/941)
- `NUT10Option.tags` is now optional. No unsafe production `.tags.length` access was
  found.
- `PrepareMeltConfig` was removed in favor of `MeltProofsConfig`; Coco does not import it.
- SIG_ALL signing packages no longer carry digests; Coco does not use `SigAll`.
- Direct `sendOffline` now throws when no exact offline subset exists instead of returning
  an empty send; Coco has no direct production call.
  [PR #871](https://github.com/cashubtc/cashu-ts/pull/871)
- cashu-ts now requires a 64-byte deterministic seed at runtime. Coco's `SeedService`
  already enforces exactly 64 bytes.
- Amount creation and arithmetic now reject values above unsigned 64-bit range. Coco
  already routes stored amounts through `Amount.from`; add a boundary regression test,
  but no legitimate wallet amount should approach the limit.
- Minting a paid-but-expired quote is now allowed when unissued paid value remains. This
  is a bug fix with no call-site migration. [PR #969](https://github.com/cashubtc/cashu-ts/pull/969)

## Complete upstream change inventory

This section groups every user-facing or defensive change in the official rc.4…rc.7
range. Release commits, test-only changes, release tooling, image bumps, and documentation
are listed separately at the end.

### `5.0.0-rc.5` (2026-07-23)

**Payment requests / public API**

- NUT-18 mint preference polarity, supported methods and fees, tri-state `singleUse`,
  options-object constructor, and new public types
  ([#683](https://github.com/cashubtc/cashu-ts/pull/683)).
- `PaymentRequestBuilder` ([#780](https://github.com/cashubtc/cashu-ts/pull/780)).
- End-to-end payer/receiver helpers ([#787](https://github.com/cashubtc/cashu-ts/pull/787)).
- Payload encode/decode helpers ([#853](https://github.com/cashubtc/cashu-ts/pull/853)).

**Wallet selection, keysets, and fees**

- Stale-keyset-first default selection ([#813](https://github.com/cashubtc/cashu-ts/pull/813)).
- Exact-match rounding bound fix ([#814](https://github.com/cashubtc/cashu-ts/pull/814)),
  integer RGLI sort key ([#815](https://github.com/cashubtc/cashu-ts/pull/815)), and
  u64-safe proof selection ([#822](https://github.com/cashubtc/cashu-ts/pull/822)).
- Newest keyset generation preferred before fee/expiry
  ([#835](https://github.com/cashubtc/cashu-ts/pull/835)); malformed and odd-length IDs
  are classified safely ([#837](https://github.com/cashubtc/cashu-ts/pull/837),
  [#839](https://github.com/cashubtc/cashu-ts/pull/839)).
- `getFeesToInclude` ([#846](https://github.com/cashubtc/cashu-ts/pull/846)), bounded fee
  convergence ([#854](https://github.com/cashubtc/cashu-ts/pull/854)), and exact integer
  keyset-fee arithmetic ([#869](https://github.com/cashubtc/cashu-ts/pull/869)).
- Exact bigint NUT-08 blank count ([#828](https://github.com/cashubtc/cashu-ts/pull/828)).
- `sendOffline` consistently throws on no exact match
  ([#871](https://github.com/cashubtc/cashu-ts/pull/871)).

**Models and utilities**

- Offline `MintInfo.getMintMeltMethod` ([#812](https://github.com/cashubtc/cashu-ts/pull/812)).
- MintInfo accessors now return mutation-isolated snapshots, preserving immutable
  `Amount` instances ([#824](https://github.com/cashubtc/cashu-ts/pull/824),
  [#826](https://github.com/cashubtc/cashu-ts/pull/826)). Object identity across calls
  is no longer stable.
- `Amount.from` and arithmetic results are bounded to u64
  ([#830](https://github.com/cashubtc/cashu-ts/pull/830),
  [#832](https://github.com/cashubtc/cashu-ts/pull/832)).
- Public strict `normalizeMintUrl` ([#834](https://github.com/cashubtc/cashu-ts/pull/834));
  non-string hex validation returns false ([#843](https://github.com/cashubtc/cashu-ts/pull/843));
  `splitAmount` output count is bounded ([#859](https://github.com/cashubtc/cashu-ts/pull/859)).
- Public secp256k1 key validation ([#863](https://github.com/cashubtc/cashu-ts/pull/863)).

**Untrusted-input and quote hardening**

- Locked mint quote public keys are required and validated across typed and generic quote
  paths ([#851](https://github.com/cashubtc/cashu-ts/pull/851),
  [#856](https://github.com/cashubtc/cashu-ts/pull/856),
  [#861](https://github.com/cashubtc/cashu-ts/pull/861),
  [#875](https://github.com/cashubtc/cashu-ts/pull/875)).
- Mint-advertised keyset denomination count is bounded
  ([#864](https://github.com/cashubtc/cashu-ts/pull/864), with limit centralization in
  [#866](https://github.com/cashubtc/cashu-ts/pull/866)).
- P2PK witness and CBOR decode bounds plus P2PK edge-case hardening
  ([#874](https://github.com/cashubtc/cashu-ts/pull/874),
  [#877](https://github.com/cashubtc/cashu-ts/pull/877)).
- Diagnostic, wallet, and OIDC debug logging was made safer/clearer
  ([#879](https://github.com/cashubtc/cashu-ts/pull/879),
  [#881](https://github.com/cashubtc/cashu-ts/pull/881),
  [#883](https://github.com/cashubtc/cashu-ts/pull/883)).

### `5.0.0-rc.6` (2026-08-12)

**Runtime and parser hardening**

- Safer response reads and JSON number-token parsing
  ([#886](https://github.com/cashubtc/cashu-ts/pull/886)).
- HTLC, NUT-10, P2PK locktime/tag, and unique-signer validation
  ([#892](https://github.com/cashubtc/cashu-ts/pull/892),
  [#893](https://github.com/cashubtc/cashu-ts/pull/893),
  [#894](https://github.com/cashubtc/cashu-ts/pull/894),
  [#904](https://github.com/cashubtc/cashu-ts/pull/904)).
- Prototype-chain-safe CBOR/keyset lookup, bounded JSON nesting, response sizes, mint
  method/endpoint lists, key denominations, deterministic counters, and key generation
  height ([#895](https://github.com/cashubtc/cashu-ts/pull/895),
  [#907](https://github.com/cashubtc/cashu-ts/pull/907),
  [#928](https://github.com/cashubtc/cashu-ts/pull/928),
  [#919](https://github.com/cashubtc/cashu-ts/pull/919),
  [#938](https://github.com/cashubtc/cashu-ts/pull/938)).
- Base64 fallback chunk alignment ([#905](https://github.com/cashubtc/cashu-ts/pull/905))
  and escaped log control characters ([#906](https://github.com/cashubtc/cashu-ts/pull/906)).
- Duplicate proof secrets are rejected before totaling/selection, with the offending
  index reported ([#916](https://github.com/cashubtc/cashu-ts/pull/916),
  [#917](https://github.com/cashubtc/cashu-ts/pull/917)).
- Exactly 64-byte deterministic seeds are required
  ([#920](https://github.com/cashubtc/cashu-ts/pull/920)).
- BLS signer validates blinded points ([#931](https://github.com/cashubtc/cashu-ts/pull/931)).

**Wallet/API behavior**

- Manual deterministic counter ranges are atomically claimed through required
  `CounterSource.reserveAt` ([#923](https://github.com/cashubtc/cashu-ts/pull/923)).
- BOLT11 quote/invoice amount validation ([#925](https://github.com/cashubtc/cashu-ts/pull/925)).
- Melt `extraPayload` cannot overwrite reserved request fields
  ([#908](https://github.com/cashubtc/cashu-ts/pull/908)).
- Keyset-unit lookup is map-backed ([#909](https://github.com/cashubtc/cashu-ts/pull/909)).
- `getTokenMetadata` returns `proofAmounts` instead of partial proofs
  ([#941](https://github.com/cashubtc/cashu-ts/pull/941)).
- Blinded SIG_ALL batches reuse one ephemeral key, and signing digests are recomputed
  from package contents rather than transported
  ([#946](https://github.com/cashubtc/cashu-ts/pull/946),
  [#947](https://github.com/cashubtc/cashu-ts/pull/947)).
- Public return types were aligned with runtime values, including optional NUT-10 tags
  and `MeltProofsConfig` replacing `PrepareMeltConfig`
  ([#955](https://github.com/cashubtc/cashu-ts/pull/955)).

**Authentication and transport**

- OIDC provider URLs must be HTTP(S), token-bearing requests do not follow redirects,
  stale CAT refreshes are discarded, device polling intervals are finite, and token
  listeners are detached when providers change
  ([#896](https://github.com/cashubtc/cashu-ts/pull/896),
  [#926](https://github.com/cashubtc/cashu-ts/pull/926),
  [#927](https://github.com/cashubtc/cashu-ts/pull/927),
  [#929](https://github.com/cashubtc/cashu-ts/pull/929),
  [#939](https://github.com/cashubtc/cashu-ts/pull/939)).
- WebSocket events from replaced connections are ignored
  ([#930](https://github.com/cashubtc/cashu-ts/pull/930)).

### `5.0.0-rc.7` (2026-08-16)

- Rotation-aware keychain refresh, stale/unknown keyset errors, strict cached-keyset
  mode, keychain update event, melt input snapshot checks, and recoverable melt-change
  errors ([#978](https://github.com/cashubtc/cashu-ts/pull/978)).
- State/restore request batches use the mint's advertised NUT-06 cap, falling back to
  500 ([#965](https://github.com/cashubtc/cashu-ts/pull/965)).
- Paid expired mint quotes can issue their remaining paid amount
  ([#969](https://github.com/cashubtc/cashu-ts/pull/969)).

### Supporting, non-runtime changes in the range

- Added a security policy, Apache-2.0 dual licensing, and refreshed contribution/PR
  guidance.
- Added type-checking of the upstream test tree and fixed fixture drift.
- Expanded payment-request, fee, keyset, mint-capability, restore, and migration docs.
- Updated upstream test mint container versions and release/lint plumbing.
- Release commits published rc.5, rc.6, and rc.7.

These do not require Coco source changes, aside from reviewing whether the new dual-license
metadata affects generated notices.

rc.4 and rc.7 otherwise have the same four direct runtime dependencies, the same
Node `>=22.4.0` engine declaration, ESM package type, and root-only export map. The upgrade
does not introduce a separate runtime or toolchain migration.

## Proposed upgrade validation matrix

At minimum, run:

```sh
bun run build
bun run typecheck
bun run --filter='@cashu/coco-core' test
bun run --filter='@cashu/coco-adapter-tests' build
bun run --filter='@cashu/coco-sqlite' test
bun run --filter='@cashu/coco-indexeddb' test
bun --cwd packages/expo-sqlite test
```

Add targeted tests before relying on the general suite:

- options-object request construction, field-preserving reconstruction, and rc.4 request decoding;
- fail-closed parse rejection of `mp=true` and non-empty `sm` requests before mint resolution;
- acceptance of absent or explicitly false `mp` under the existing strict-list behavior;
- regression coverage for the existing gross-amount payer and receiver behavior;
- keyset rotation between prepare and execute for mint/send/receive/pre-melt swap;
- stale failure with and without successful snapshot repair, with no automatic replacement;
- caller-created retry using a new operation and fresh outputs after safe rollback;
- cleanup failure returning a recovery-required error rather than a retryable stale error;
- unknown input keysets and paid melts with missing change entering operation-specific recovery;
- concurrent stale failures coalescing one mint refresh and invalidating every unit-scoped wallet;
- failed refresh remaining required across restart instead of trusting the old freshness timestamp;
- BLS keyset advertised while Coco remains in secp-only mode;
- stale-dust selection under the new default selector;
- BOLT11 amount mismatch and fake-invoice fixtures;
- u64 boundary and malformed nested/oversized input rejection.

## Primary sources

- [Official npm package/version](https://www.npmjs.com/package/@cashu/cashu-ts/v/5.0.0-rc.7)
- [Official npm registry metadata](https://registry.npmjs.org/@cashu%2fcashu-ts)
- [Official rc.4…rc.7 GitHub comparison](https://github.com/cashubtc/cashu-ts/compare/v5.0.0-rc.4...v5.0.0-rc.7)
- [rc.5 release](https://github.com/cashubtc/cashu-ts/releases/tag/v5.0.0-rc.5)
- [rc.6 release](https://github.com/cashubtc/cashu-ts/releases/tag/v5.0.0-rc.6)
- [rc.7 release](https://github.com/cashubtc/cashu-ts/releases/tag/v5.0.0-rc.7)
- [rc.7 migration guide](https://github.com/cashubtc/cashu-ts/blob/v5.0.0-rc.7/migration-5.0.0.md)
- [rc.7 public API snapshot](https://github.com/cashubtc/cashu-ts/blob/v5.0.0-rc.7/etc/cashu-ts.api.md)
