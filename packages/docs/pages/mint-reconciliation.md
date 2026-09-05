# Mint claiming and recovery

Coco uses the same quote balance rules for BOLT11, BOLT12, and on-chain minting. Automatic claiming
requests the currently available amount after accounting for earlier local issuance, unresolved
claims, and mint limits. A normal paid 100-sat BOLT11 invoice still produces one 100-sat claim.
If the mint reports 100 paid and 40 issued, Coco can claim the remaining 60.

The amount passed to `ops.mint.prepare` is the exact operation amount. Coco never changes an
existing operation's amount or outputs to fit a later quote observation. Older full-only BOLT11
mints can reject explicit smaller claims; normal full-amount claiming remains compatible.

Quote expiry is a payment deadline. Local expiry does not block funded issuance or recovery.
Canonical quote responses still determine paid and issued totals.

## Operation results

- `pending`: outputs are prepared and Coco knows that issuance has not been submitted.
- `executing`: issuance has been authorized and may have reached the mint. This state can persist
  after a timeout or restart, and remains visible in `listInFlight` and diagnostics.
- `finalized`: complete evidence proves the operation's exact outputs were issued. This does not
  promise that all those proofs remain spendable now.
- `failed`: Coco received a definitive rejection without an earlier unresolved submission.

Recovery first uses saved exact evidence and Restore. Quote-wide issued totals cannot complete an
unrelated operation. Partial signatures leave the operation unresolved. Empty or unavailable Restore
does not cancel it or release its reservation.

Coco currently waits for exact evidence instead of automatically resubmitting an ambiguous request.
A crash just before transmission can therefore need operator investigation even when no signatures
exist yet. Retrying `execute` or running recovery preserves that commitment; it does not create a
new request. Do not delete the operation or its recovery data to bypass this protection.

Recovered proofs that are already spent never enter ready balance. When their current state is
unknown or pending, Coco holds them durably and checks them during recovery before exposing them as
spendable. A finalized operation can therefore appear before its ready balance is available.

## Storage upgrade

Upgrade core and storage adapters together. Stop all old application processes or browser tabs
before upgrading, and use only the upgraded versions against that Wallet afterward. Mixed-version
writers and downgrade after using the new recovery schema are unsupported. SQL applications must
enforce exclusive upgrade; an old running binary cannot be fenced retroactively by the new library.

Existing operation history and deterministic counters are preserved. Old pending records can have
unknown submission history and move to `executing` for conservative recovery. Old finalized and
failed history is preserved without automatic re-crediting or repair.

Custom adapters must implement `mintRecoveryRepository` in the root and transaction scopes. This is
a breaking adapter contract change; recovery must never fall back to volatile memory.
