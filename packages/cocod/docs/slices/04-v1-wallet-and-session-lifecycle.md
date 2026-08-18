# Slice 4: V1 Wallet and Coco Session Lifecycle

Depends on [Slice 3](./03-v1-http-foundation-and-status.md).

## Outcome

Administrative clients can initialize the host-generated Wallet and control the Coco Session
through the specified asynchronous contract.

## Module interface

The route handlers translate validated HTTP commands into `CocodRuntime` calls and translate
runtime results into v1 resources. Lifecycle state, transition serialization, cleanup, and retry
rules remain inside `CocodRuntime`.

Process-local idempotency wraps accepted HTTP commands; it does not become part of the runtime's
lifecycle interface.

## Includes

- Add `POST /v1/admin/wallet/initialize` with host-generated Wallet Recovery Material.
- Add `POST /v1/admin/session/start` and `POST /v1/admin/session/stop`.
- Map accepted versus completed transitions to `200`, `201`, and `202` responses.
- Add bounded, process-local `Idempotency-Key` handling for lifecycle mutations.
- Extend the runtime schemas and generated interface description with the lifecycle commands.
- Cover retry, conflicting keys, concurrent callers, disconnects, and every runtime failure state.

## Excludes

- Wallet Import.
- Wallet Recovery Material re-export.
- Cocod Process shutdown.
- TCP transport.

## Acceptance

- Every required lifecycle scenario in the network specification passes as a route contract test.
- Reusing an idempotency key with a different request returns `idempotency_key_conflict`.
- Disconnecting a client does not cancel an accepted transition.
- No lifecycle rule is duplicated outside `CocodRuntime`.
