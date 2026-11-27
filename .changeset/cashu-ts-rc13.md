---
'@cashu/coco-core': major
'@cashu/coco-adapter-tests': major
'@cashu/coco-sql-storage': major
'@cashu/coco-sqlite': major
'@cashu/coco-sqlite-bun': major
'@cashu/coco-expo-sqlite': major
'@cashu/coco-indexeddb': major
---

Upgrade `@cashu/cashu-ts` to `5.0.0-rc.13`, pinned exactly in `@cashu/coco-core` and in the
`@cashu/cashu-ts` peer dependency of every adapter package. v3 (`02`-prefix) keysets stay closed:
Coco never holds, selects or stores proofs on them, including after a mint rejects a keyset.
Mint, melt, send, receive, payment requests, Restore and Sweep behave as before on pre-v3 mints,
except as listed below. No repository contract changes and no persistence migration is needed;
storage adapters keep working unchanged.

`@cashu/coco-adapter-tests` now requires `fake-bolt11` `^0.1.1`, which writes the canonical invoice
cashu-ts compares a melt quote's `request` against.

Changes from Coco:

- A payment request locked only with `nutroot` is refused with a `PaymentRequestError` by
  `paymentRequests.parse()` and `prepare()` instead of being paid with unlocked proofs. A request
  with both a NUT-10 and a `nutroot` lock is paid through its NUT-10 lock, as before.
- After a mint rejects a swap, a mint or a batch mint for its keyset (a NUT-00 code from 12000 to
  12999), Coco fetches the mint's metadata once the operation's outcome is stored. The outcome
  itself is unchanged, and a failed refresh is only logged.
- Initial submission checks the saved output keysets before marking an operation executing. A
  prepared swap Send can still be cancelled if a keyset refresh has retired its outputs.
- `wallet.sweep()` rejects a seed that is not a 64-byte `Uint8Array` with a `ProofValidationError`
  before it adds the mint. A seed of 16 to 63 bytes could be swept before.
- A bolt11 mint quote whose amount differs from the requested amount is rejected, locked or not:
  by cashu-ts for a locked quote, with a `MintQuoteValidationError` for an unlocked one, which was
  not checked before.
- Restore and Sweep send restore batches no larger than the mint's advertised `max_array_length`.

Changes from cashu-ts that reach Coco callers:

- `Amount` throws on implicit numeric coercion, rejects a value above the u64 maximum, and accepts
  only a genuine instance: an `Amount` copied by prototype or wrapped in a `Proxy` (as reactive
  state libraries do) is rejected.
- `getDecodedToken` rejects a token in standard base64, as NUT-00 mandates url-safe base64.
- `getTokenMetadata().incompleteProofs` is now `proofAmounts`.
- `OutputDataLike.spendInfo` is optional.
- New `creqA` payment request strings are url-safe, and `PaymentRequest.singleUse` can be
  `undefined`.
- Keyset choice is version-first: a newer-version keyset wins over a cheaper older one.
- Creating a bolt11 melt quote fails when the mint's `request` differs from the invoice sent.
- A bolt11 payment preimage that does not match the invoice reads as absent whenever the mint's
  answer carries the invoice.
- A quote response with an empty unit, or a unit other than the wallet's, is rejected.
- A melt quote that charges more than the invoice (bolt11) or the explicit amount (bolt12), and an
  onchain melt quote for another amount than requested, are rejected.
- A bolt12 mint quote for another amount than requested is rejected.
- A melt quote with an empty `request`, and a quote lookup answered for another quote id, are
  rejected.
- A paid bolt12 or onchain mint quote past its expiry is sent to the mint instead of being refused
  locally, so it is minted if the mint allows it.
- A request with a body no longer follows a redirect: a mint that answers a POST with a 307 or 308
  now fails the request.
- A malformed mint info response (no well-formed `nuts`, or a malformed NUT-04 or NUT-05 section)
  is rejected; other malformed sections are dropped, and overlong contact and URL lists are cut.
- An OIDC provider whose https discovery document names an http endpoint is refused.
- Re-exported types: in `MintInfo`, a NUT-04/05 method entry's `method_name`, `min_amount` and
  `max_amount` are optional in the type, and `Proof.dleq` requires `r`.
