---
'@cashu/coco-react': patch
---

Document the React package's operation-oriented API more clearly.

This updates the React README and docs to explain:

- the `useSendOperation()`, `useReceiveOperation()`, `useMintOperation()`, and
  `useMeltOperation()` hooks
- how `currentOperation`, `executeResult`, `load()`, and bound follow-up
  methods work
- which providers are required for operation hooks versus derived-data hooks
- how to migrate from the removed `useSend()` and `useReceive()` APIs
