# Core Transaction Hardening: Send (#449–#452)

- [x] Build Send transaction operations on the strong Wallet scope and shared runner.
- [x] Make Send preparation reserve proofs, allocate outputs, and persist prepared atomically.
- [x] Execute exact-match Sends as one local prepared-to-pending transition.
- [x] Persist executing before swap mint I/O and apply swap results atomically.
- [x] Make completion, cancellation, legacy rollback, and Operation Recovery transaction-safe.
- [x] Preserve Send method handlers as the lifecycle-policy seam.
- [x] Claim executing-send recovery through an authoritative revision before replaying mint I/O.
- [x] Keep remote mint I/O outside transactions and publish events only after commit.
- [x] Preserve legacy init cleanup and pending default-token reclaim compatibility.
- [x] Cover crash boundaries, conflicts, replay, idempotence, and post-commit events.

## Scope boundary

Do not migrate Receive, Mint Swap, or Payment Request parent/attempt atomicity in this slice. The
durable outbox, general fault injection, and pending default-token reclaim redesign remain separate.
