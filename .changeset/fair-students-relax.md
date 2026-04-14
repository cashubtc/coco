---
'@cashu/coco-core': patch
'@cashu/coco-react': patch
---

Make React operation hooks reactive to manager events and simplify their binding
lifecycle, while only persisting receive history once a receive is finalized.

React operation hooks now stay bound to one operation for the lifetime of the
hook instance, hydrate an initial `operationId` on mount, and update
`currentOperation` from background operation events instead of requiring manual
`load()` rebinding. The public `load()` method has been removed; if a mounted
component needs to switch to a different operation, remount the hook or
component with a new React `key`. This also guards against stale hydration
results overwriting newer event-driven operation state.

Core now records receive history only once a receive is finalized, instead of
creating receive history entries during the prepared state. The legacy
`receive:created` core event has also been removed.
