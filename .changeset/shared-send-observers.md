---
'@cashu/coco-react': patch
---

`useSendOperation` instances that follow the same Send now share one observed record per Manager.
They share the initial read, and an action result from one instance reaches the others even when
core emits no event for it, and so does an operation object passed as the binding. Records from
different Managers stay separate when their operation IDs match: after a Manager change the hook
rereads its selected Send from the new Manager. A newer persistence revision always wins over an older one, and a missing legacy revision
counts as zero. The hook's return value is unchanged.
