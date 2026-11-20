---
'@cashu/coco-react': patch
---

Fix `useSendOperation`, `useReceiveOperation`, `useMintOperation` and `useMeltOperation` leaving
`currentOperation` null when given an existing operation id under React StrictMode. Loading that
operation no longer takes the lock that serializes actions, so the StrictMode effect replay joins the
read already in flight instead of clearing the binding. A read that settles after `reset()` or
unmount is ignored, and `prepare()` can start immediately after `reset()` while such a read is still
pending.
