# Slice 3: V1 HTTP Foundation and Status

Depends on [Slice 2](./02-shared-administrative-credential.md).

## Outcome

`/v1` has one small route interface for JSON success, stable errors, authentication, runtime
schemas, and safe request logging.

## Module interface

A v1 route declares its method, path, required Client Capability, request schema, response schema,
and handler. The v1 route runner owns parsing, authorization, error mapping, request IDs, redaction,
and response serialization. Handlers receive already-validated input and return domain results.

Legacy route envelopes remain outside this interface.

## Includes

- Add unauthenticated `GET /health` and authenticated `GET /v1/status`.
- Return structured `CocodRuntime` status without legacy `{ output }` envelopes.
- Centralize v1 JSON parsing, error documents, request IDs, capability checks, and sensitive-field
  redaction.
- Define runtime schemas as the source for a generated lifecycle interface description.
- Add contract tests for every lifecycle state and authentication failure.

## Excludes

- Lifecycle mutations and idempotency.
- Wallet Recovery Material retrieval.
- Process shutdown.
- TCP transport.

## Acceptance

- The v1 route interface is tested directly and through the Unix listener.
- Runtime and generated schemas describe the same health and status documents.
- Stable errors never use legacy response envelopes.
- Every legacy CLI command continues to work.
