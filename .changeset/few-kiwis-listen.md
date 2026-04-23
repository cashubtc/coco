---
'@cashu/coco-react': patch
---

Fix `useReceiveOperation` so it subscribes to manager events with a bound
`Manager.on` call, preventing the hook from crashing when receive operation
listeners are registered.

Add a regression test that uses a `Manager.on` mock with real `this` semantics
so detached invocation failures are caught in the React hook test suite.
