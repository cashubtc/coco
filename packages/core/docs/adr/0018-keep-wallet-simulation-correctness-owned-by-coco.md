---
status: accepted
---

# Keep wallet simulation correctness owned by coco

The wallet fault simulation tests Coco's fund preservation and Operation Recovery against
protocol-correct mints under network failures and process crashes. Coco owns the workload and
correctness requirements; external fault tooling may drive and observe Coco through a thin adapter,
but must not implement wallet persistence or recovery on Coco's behalf. This preserves the value of
reusing fault infrastructure without allowing a reference wallet implementation or an external
runner's weaker success criteria to hide Coco failures.

Cashu Fault Lab is a candidate for selective reuse, not an adopted dependency. Its integration must
preserve this ownership; choosing tooling does not change Coco's recovery contracts. The confirmed
[simulation design](../../../../docs/design/wallet-fault-simulation.md) records the agreed fault
model and implementation requirements.
