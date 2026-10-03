# Amounts and JSON Boundaries

Public balances, operations, and parsed payment requests contain rich `Amount`
objects. An `Amount` has methods such as `equals()`, `add()`, and `toString()`;
its internal value is a `bigint`. `JSON.stringify()` on a live instance uses its
`toJSON()` method and emits a decimal string. Parsing that JSON returns strings,
not `Amount` instances. A TypeScript cast cannot restore the methods.

Structured cloning (for example, posting an object to a worker or copying a
browser result into a test driver) can instead drop the prototype while retaining
the internal `bigint`. A later `JSON.stringify()` can then throw. Convert to an
explicit DTO before crossing the boundary; do not depend on private fields of a
cloned amount.

## Display and Input DTOs

Keep both amount and unit, using decimal strings to preserve integers beyond
`Number.MAX_SAFE_INTEGER`:

```ts
import { Amount, type Manager } from '@cashu/coco-core';

type BalanceDto = { amount: string; unit: string };

async function getBalanceDto(coco: Manager): Promise<BalanceDto> {
  const balance = await coco.wallet.balances.total({ units: ['sat'] });
  return { amount: balance.total.toString(), unit: 'sat' };
}

function readBalanceDto(input: unknown) {
  if (
    !input ||
    typeof input !== 'object' ||
    !('amount' in input) ||
    typeof input.amount !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(input.amount) ||
    !('unit' in input) ||
    typeof input.unit !== 'string' ||
    input.unit.trim() === ''
  ) {
    throw new Error('Expected a decimal amount string and unit');
  }
  return { amount: Amount.from(input.amount), unit: input.unit };
}
```

Validate untrusted JSON before using it. Rehydrate only your own explicit DTO
fields with `Amount.from()`; pass `{ amount, unit }` together to Coco APIs that
accept unit-aware inputs. Do not convert large amounts to JavaScript numbers.
This DTO is for the app boundary, not a replacement for Coco's storage adapters.

## Payment Requests Across HTTP or Workers

Send an encoded `creqA`/`creqB` request to the process that owns the Coco Session.
Parse it there immediately before preparation. Do not JSON-round-trip a
`ResolvedPaymentRequest` and cast it back to the public type: both its amounts
and nested `PaymentRequest` instance have behavior that JSON cannot restore.

The following host functions take already validated route inputs. The prepared
object stays in the owning process between confirmation and execution:

```ts
import type { Manager } from '@cashu/coco-core';

function paymentHandlers(coco: Manager) {
  type Prepared = Awaited<ReturnType<Manager['paymentRequests']['prepare']>>;
  const pending = new Map<string, Prepared>();

  return {
    async prepare(encodedRequest: string, mintUrl: string) {
      const request = await coco.paymentRequests.parse(encodedRequest);
      const prepared = await coco.paymentRequests.prepare(request, { mintUrl });
      const id = prepared.sendOperation.id;
      pending.set(id, prepared);
      return { id, amount: prepared.sendOperation.amount.toString(), unit: request.unit };
    },
    async execute(id: string) {
      const prepared = pending.get(id);
      if (!prepared) throw new Error('Prepared payment is not available in this session');
      const result = await coco.paymentRequests.execute(prepared);
      pending.delete(id);
      return result.type === 'inband'
        ? { id, type: result.type, encodedToken: coco.wallet.encodeToken(result.token) }
        : { id, type: result.type, delivered: result.response.ok };
    },
  };
}
```

Use the existing operation ID for normal `ops.*.get()`, `refresh()`, cancellation,
and recovery. In an HTTP host, scope the map and ID lookup to the authorized
wallet/session. This small map is process-local: it is not a durable payment-request
queue. After restart, inspect and recover the existing send operation; do not
blindly prepare the request again, which can create a second send. A production
host also needs expiration/cancellation for abandoned confirmations and a delivery
policy for tokens produced before a transport failure.

For complete incoming request payloads and claims, see
[Payment Requests](../starting/payment-requests.md#complete-inband-round-trip).

## Diagnostic Transcripts

For logs of already-cloned objects, a local replacer can handle stray `bigint`
values without changing the global `BigInt` prototype:

```ts
function diagnosticJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));
}
```

This produces a diagnostic representation only; it does not restore Coco models
or define a stable wire format. Prefer the explicit DTO conversion before a
clone. Log selected public status fields rather than whole wallet objects, which
can contain token secrets or key material.
