---
'@cashu/coco-react': major
---

Replace the legacy `useSend` and `useReceive` React hooks with operation-based
hooks that mirror `manager.ops.*`.

This change adds `useSendOperation`, `useReceiveOperation`, `useMintOperation`,
and `useMeltOperation`, all of which expose durable `currentOperation` state,
`executeResult`, optional initial binding from an operation or operation id,
and bound lifecycle methods such as `load()`, `refresh()`, and `execute()`.

The new hooks remove the older callback-style action options in favor of
promise-returning methods plus hook-managed `status` and `error` state.
