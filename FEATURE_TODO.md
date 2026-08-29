# Cocod CLI v1 Lifecycle Alignment

- [x] Verify authenticated TCP and lifecycle v1 are merged into `master`.
- [x] Read the Cocod Host and Coco Cashu context documents and lifecycle ADRs.
- [x] Add focused client and route tests for the v1 cutover.
- [x] Introduce one typed v1 client interface with structured error parsing.
- [x] Move CLI health, status, Wallet initialization, and Coco Session commands to v1.
- [x] Keep Cocod Process reachability separate from Coco Session readiness.
- [x] Remove `/ping`, `/status`, `/init`, and `/unlock` from the daemon.
- [x] Update CLI help and daemon API documentation.
- [x] Build, typecheck, and test `cocod`.

## Review follow-up

- [x] Fail lifecycle commands when their requested target state is not reached.
- [x] Expose repeatable Wallet Recovery Material retrieval through the CLI.
- [x] Poll lifecycle transitions beyond the server's default 30-second cleanup deadline.

## CLI naming

- Use `health` for public Cocod Process liveness.
- Use `wallet initialize` for host-generated Wallet Recovery Material.
- Use `session start` and `session stop` for Coco Session lifecycle transitions.
- Keep top-level `stop` for Cocod Process shutdown.
- Do not retain `ping`, `init`, or `unlock` aliases.

## Scope boundary

Keep balance, receive, send, mint, history, event, NPC, and X-Cashu routes on their existing
authenticated legacy contracts until their v1 resources are designed.

---

# cashu-ts `5.0.0-rc.7` Upgrade

## Preparation

- [x] Research upstream changes from `5.0.0-rc.4` through `5.0.0-rc.7`.
- [x] Confirm strict Coco-owned Wallet Keyset Snapshots while BLS keysets remain unsupported.
- [x] Confirm the rc.5 rotating proof selector without an economic cutoff.
- [x] Define stale-keyset failure and recovery behavior in the Coco Cashu context and ADRs.
- [x] Move NUT-18 semantic alignment into a dedicated follow-up PR.
- [x] Confirm the final error contracts, cleanup ordering, and feature scope.

## Compatibility and dependency

- [x] Pin all seven direct `@cashu/cashu-ts` dependencies to `5.0.0-rc.7` and regenerate
      `bun.lock` without changing the transitive `cashu-ts@3.7.1` resolution.
- [x] Convert all production, test, and adapter `PaymentRequest` constructors to the options object.
- [x] Preserve all request fields when reconstructing a request with a caller-supplied amount.
- [x] Reject `mintsPreferred === true` and non-empty `supportedMethods` during parsing with
      `PaymentRequestError`, before exposing `payableMints`; preserve strict-list and gross-amount
      behavior for legacy requests.
- [x] Configure cached wallets with `strictCachedKeysets: true`; retain Coco's BLS filter and fail
      when no Usable Keyset exists.

## Rotation boundary

- [x] Add Coco's stable `StaleKeysetError` with operation ID, mint URL, unit, and the upstream error
      as its cause.
- [x] Add `OperationRecoveryRequiredError` with operation ID, mint URL, unit, and cause for outcomes
      that do not permit a new operation yet.
- [x] Add a forced Known Mint refresh path that invalidates every unit-scoped wallet, serializes
      concurrent refreshes through the shared mint lock, and persists a refresh requirement before
      attempting the network update.
- [x] Persist the Known Mint refresh requirement, then prove and persist safe operation rollback
      with resource release, then force the refresh.
- [x] Throw the retryable Coco stale error only after every cleanup step and the Known Mint refresh
      succeed.
- [x] Return a recovery-required error when proof, cleanup, persistence, or refresh cannot establish
      a safe retry boundary.
- [x] Reuse existing operation states, repositories, events, and history fields; add structured logs
      without schema migrations or a new public event.

## Operation integration

- [x] Mint: recover quote/output state; fail the current operation as retryable only when issuance
      is proven unapplied, using existing `terminalFailure` metadata.
- [x] Send, including P2PK: inspect reserved input state; roll back and release only when the swap is
      proven unapplied, otherwise recover the original operation's outputs.
- [x] Receive: roll back only while every input remains unspent; recover and finalize the original
      operation when inputs were spent.
- [x] Melt and pre-melt swap: roll back only after the quote and input states prove the payment and
      swap unapplied; preserve pending and paid outcomes.
- [x] Recover `MeltChangeError` through the original melt, returning finalized or pending when
      established and recovery-required otherwise.
- [x] On `UnknownKeysetError`, force one refresh and return `KeysetSyncError` if the keyset remains
      unknown; never classify it as a retryable stale-output failure.

## Other rc behavior

- [x] Accept `selectProofsRotating` and add structured selection diagnostics covering proof value,
      input fee, and keyset age/status.
- [x] Verify existing quote fixtures and mismatch tests against rc.6 BOLT11 amount/invoice
      validation; no fixture changes are required.
- [x] Verify u64 amount boundaries, exact seed length, malformed input, and changed public types used
      by Coco.
- [x] Defer cashu-ts URL normalization, payment-request builder/payload helpers, method-fee helpers,
      and default cashu-ts-owned keychain repair.

## Validation

- [x] Test stale rotation between prepare and execute for mint, send/P2PK send, receive, pre-melt
      swap, and melt change.
- [x] Test safe caller-created replacement operations and prove no automatic replacement occurs.
- [x] Test ambiguous and cleanup-failure paths remain recovery-required with resources retained.
- [x] Test concurrent stale failures, all-unit cache invalidation, failed refresh across restart,
      BLS-only active keysets, and unknown input keysets.
- [x] Run root build and typecheck, core tests, adapter-tests build, SQLite tests, IndexedDB tests,
      and Expo SQLite tests.

## Delivery

- [x] Keep reviewable commits for compatibility, rotation infrastructure, operation recovery,
      selector/fixtures, and the final dependency/lockfile validation.
- [ ] Follow with a separate NUT-18 PR implementing ADR-0014.
