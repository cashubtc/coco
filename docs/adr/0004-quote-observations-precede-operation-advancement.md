# Quote observations precede operation advancement

Coco records a Quote Observation into the canonical quote row before advancing any Quote-backed
Operation from that observation. Watchers therefore observe and persist quote state, while separate
operation processors react to quote update events and call the operation saga; this keeps remote
quote observation separate from proof mutation and prevents future maintainers from folding
subscription handling directly into operation finalization.
