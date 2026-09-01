# Core Transaction Hardening: Receive (#453–#455)

- [x] Build Receive transaction operations on the strong Wallet scope and shared runner.
- [x] Complete token validation and P2PK signing before opening the repository transaction.
- [x] Persist signed inputs and Output Allocation atomically in prepared.
- [x] Commit executing before mint I/O and apply successful results atomically.
- [x] Treat explicit spent-input rejection as definitive and transport failure as ambiguous.
- [x] Reuse the Exact Operation Request for replay and Restore-based Operation Recovery.
- [x] Make result application and recovery idempotent through authoritative revisions.
- [x] Keep remote mint I/O outside transactions and publish events only after commit.
- [x] Preserve legacy init cleanup and Payment Request source metadata.
- [x] Cover crash boundaries, replay, Restore, conflicts, and post-commit events.

## Scope boundary

Payment Request parent/attempt atomicity, Mint Swap migration, the durable outbox, and general fault
injection remain separate follow-up work.
