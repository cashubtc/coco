# cashu-ts owns wire quote normalization

Status: accepted

cashu-ts `Mint` and `Wallet` APIs own normalization of wire-level mint quote responses, so Coco does
not duplicate that compatibility boundary. Coco owns the canonical Mint Quote model, persistence,
Quote Observation resolution, and wallet-specific semantics after a normalized snapshot crosses
the boundary. The wire boundary became effective in #298; canonical ownership became effective in
#299.
