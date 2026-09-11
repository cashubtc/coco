---
'@cashu/coco-core': major
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

Recover legacy exact Sends stranded in `executing` by atomically releasing their unsubmitted
inputs. Resume legacy swaps with locally spent inputs or previously saved outputs without
duplicating proofs or resetting later output spending and reservations.

Complete pending Sends whose spent input reservations were already released before an interrupted
finalization. Preserve partial proof observations and conflicting-owner checks, and publish release
events only for reservations actually released by completion.

Breaking adapter contract: custom `SendOperationRepository` implementations must now implement
`transition`. It must atomically compare the persisted state and revision (missing legacy revisions
count as zero), apply the next operation with revision incremented by one, and return `false` without
writing on a mismatch. Use the caller's repository transaction so proof writes roll back if the
transition fails. Bundled adapters implement this contract.

Finalize legacy pending P2PK sends whose old recovery omitted both the token and spent output proofs.
Verify every persisted send output with the mint and revalidate the allocation and revision in the
completion transaction. Preserve unresolved operations and never fabricate missing proofs or tokens.
