---
'@cashu/coco-core': minor
'@cashu/coco-indexeddb': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
---

Route Send preparation, execution, completion, cancellation, and Operation Recovery through domain
transaction gateways so proof, counter, token, and operation transitions commit atomically while
remote mint requests remain outside repository transactions.

Share scoped proof and Output Allocation commands across Send transitions and pending-token reclaim.
Persist reclaim output plans separately from the original Send request, apply reclaim results
atomically, and preserve recovery request material for persisted operations. Keep unknown mint
errors and replay rejections recoverable, fence initial failures against concurrent recovery claims,
and restrict Send reservation cleanup to known terminal Send owners so it cannot
release another workflow’s inputs.

Use the shared transaction naming convention consistently: `*Input` argument types, `input`
parameters, and `work` runner callbacks. Keep `Scoped*Commands` for mutations within an existing
transaction and `SendOperationService` for the durable saga coordinator.

Share mint metadata refresh through the explicitly committing
`MintService.refreshAndCommitIfStale` action and a dedicated metadata transaction gateway. Keep
freshness policy, fetching, and post-commit mint events out of Send; existing metadata refresh
callers reuse the same action.
