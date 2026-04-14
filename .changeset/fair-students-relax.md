---
'@cashu/coco-core': patch
'@cashu/coco-react': patch
---

Make React operation hooks reactive to manager events and simplify their binding
lifecycle, while only persisting receive history once a receive is finalized.

React operation hooks now stay bound to one operation for the lifetime of the
hook instance, hydrate an initial `operationId` on mount, and update
`currentOperation` from background operation events instead of requiring manual
`load()` rebinding. This also guards against stale hydration results
overwriting newer event-driven operation state.

Core now records receive history from finalized receive flows and emits
`receive:created` so finalized history entries can be enriched with token data
when a token is produced.
