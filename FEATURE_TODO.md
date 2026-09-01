# Core Transaction Hardening: Keypair Allocation (#448)

- [x] Build the composition-root-owned transaction runner on the strong Wallet scope.
- [x] Load the Wallet Seed before opening the repository transaction.
- [x] Pass only a synchronous, purpose-bound key deriver into the transaction.
- [x] Commit the derived keypair and high-water allocation atomically.
- [x] Route public P2PK and mint-quote key generation through the gateway.
- [x] Keep existing key import, lookup, signing, and deletion behavior.
- [x] Cover retry, allocation, service, and composition-root behavior.

## Scope boundary

Do not migrate Send, Receive, Mint Swap, or other orchestration in this slice. Remote mint I/O,
durable event delivery, and general fault injection remain separate work.
