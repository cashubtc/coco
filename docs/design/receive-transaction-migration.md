# Receive transaction migration

Receive uses the transaction foundation introduced by the Keypair and Send migrations. The
existing Receive behavior and public Wallet/Receive APIs remain the contract: preparation stores
the exact signed inputs and deterministic outputs, execution commits its authorization before mint
I/O, and recovery reconciles the persisted request.

## Responsibilities

- `ReceiveOperationService` coordinates read-only operation, proof, and mint queries; token
  decoding; signing through `P2pkSigner`; seed loading; remote requests; transaction gateways;
  and publication after commit. It holds neither repositories nor the runner nor broad Services.
- `CoreReceiveTransactions` opens exactly one runner invocation per atomic command. It is a leaf
  gateway and does not compose other application gateways.
- `RepositoryReceiveCommands` owns Receive transitions inside one adapter scope. It reuses the
  same scoped proof, output-allocation, and mint-metadata commands used by Send. It never opens a
  transaction or invokes remote infrastructure, Services, or the live event bus.
- `CashuReceiveRemote` implements swap, proof-state checks, and Restore using committed metadata.
  `CashuMintClient` supplies the common protocol-only wallet and metadata fetch used by Send and
  Receive. Neither persists Wallet state. `observeOutputProofs` shares Restore matching and
  unblinding with existing ProofService and Send callers.
- Pure token decoding and proof identity/validation are shared. The legacy TokenService and
  ProofService wrappers remain available to workflows that have not migrated yet.

## Atomic boundaries

| Gateway command                    | Authoritative reads and atomic writes                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `refreshMintMetadata`              | Apply fetched metadata/keysets together while preserving locally owned trust. Publish mint events after commit.                                                                            |
| `prepare`                          | Reject an existing operation ID, verify trust, calculate fees from current keysets, validate the active output keys, allocate counters, and create the prepared request in the same scope. |
| `beginExecution`                   | Reload the prepared operation, validate request material, conditionally advance its revision/state, then return the saved transport request.                                               |
| `applyResult`                      | Reload the executing operation, validate exact output identity and amount, reconcile issued proofs, and conditionally finalize. A repeated matching application makes no duplicate writes. |
| `failExecution` / `cancelPrepared` | Reload state and revision, then conditionally record the terminal result.                                                                                                                  |
| `deleteLegacyInit`                 | Delete only a still-initial legacy row; new init intents remain transient.                                                                                                                 |

Every participating command is constructed from the same repository scope by the existing module
factory. The runner's lifetime tracking, sibling draining, and bounded conflict retries remain
unchanged. Seed loading and asynchronous P2PK signing happen before allocation; timestamps and
retry-sensitive inputs are fixed before calling a gateway. Queries never refresh or persist mint
metadata. The coordinator explicitly fetches and commits a stale metadata observation.

Incoming token proofs are not claimed or reserved locally. Issued-output reconciliation preserves
immutable proof identity and later local state/reservations; a complete spent Restore can advance
legacy partially saved outputs to spent. Send and Receive share the same counter authority.

## Recovery and compatibility

Replay uses persisted input witnesses and output data without loading the seed or signing again.
Unblinding is pinned to the saved output keyset even when another active keyset is cheaper.
Complete unspent or complete spent Restore evidence finalizes the exact result. Failed, partial,
mixed, or pending observations retain `executing`. Spent inputs with a successful empty Restore
can record failure; replay rejection uses the existing mint-error classification and Restore
decision rules. Existing prepared rows remain available for explicit execution or cancellation.

Memory repositories clone nested request data on writes and queries so caller mutation cannot
silently rewrite durable replay material. SQL keeps both independently introduced migration IDs,
`041_send_reclaim_data` and `041_receive_operation_revision`; migration bookkeeping uses complete
IDs. Already applied Receive revisions and signed requests survive merging the Send schema.
IndexedDB retains its Receive revision upgrade and optional metadata compatibility.

Payment Request source metadata is preserved. Atomic parent/attempt/child creation remains deferred
to the Payment Request migration, as specified by TRANSACTION_DESIGN and ADR-0011. Other legacy
workflows still use their existing Services; this change does not alter the architecture contract.

## Verification

Coordinator tests use real memory-backed gateways and configurable remote adapters. Coverage
includes trust rechecks, fee changes, metadata commits, independent coordinators, shared Send and
Receive counter allocation, write rollback, conditional revisions, request immutability, event
timing, signed replay after key removal, and the recovery evidence matrix. Protocol tests exercise
real cashu-ts serialization/unblinding for replay and Restore. Shared adapter contracts cover nested
Receive request isolation and revision transitions; schema tests cover legacy and already migrated
Receive databases.
