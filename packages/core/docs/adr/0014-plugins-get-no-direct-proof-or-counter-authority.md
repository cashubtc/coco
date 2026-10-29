---
status: accepted
---

# Plugins get no direct proof or counter authority

Plugins can't write Wallet proof state or Output Counters directly. Value enters or leaves a Wallet
only through operations, and new write needs become dedicated operations or transitions rather
than general mutation services. `ProofService` and `CounterService` are removed from core and from
the plugin `ServiceMap`, with nothing replacing them for plugins. Plugins read balances through a
`balances` key that exposes the same read-only `WalletBalancesApi` as `manager.wallet.balances`,
following the `quotes` precedent. There is no raw proof listing until a real plugin needs one.

Root proof and counter writes bypassed the Owning Operation and the coordinator-owned transaction
guarantees in [ADR-0011](0011-compose-wallet-transactions-in-the-owning-coordinator.md). A plugin
could save, reserve, release, delete or change the state of proofs held by an operation, or allocate
outputs outside an Output Allocation, and grouped changes were not atomic (#320, #321). Core no
longer used either service for any operation lifecycle.

Restricting reads is not a security boundary. The plugin `seedService` already exposes the Wallet
Seed, so a plugin can derive everything the removed services exposed. The removal enforces the
transaction and ownership model; it does not sandbox plugins.

## Considered Options

- **Keep the services and make each write transactional.** This would keep general mutation paths
  that still bypass the Owning Operation's rules, and every new method would need its own ownership
  checks.
- **Deprecate first, then remove.** The removal ships as a hard break in the pending
  `@cashu/coco-core` 3.0.0 major, with a migration note. A deprecation release would delay it to the
  next major.

## Consequences

`CounterRepository` and Output Allocation through `ScopedOutputs` are unchanged. The `WalletApi`
constructor requires `BalanceQueries` and no longer accepts a `ProofService`.
