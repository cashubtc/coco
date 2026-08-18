# Slice 6: Authenticated Process Shutdown

Depends on [Slice 3](./03-v1-http-foundation-and-status.md).

## Outcome

Local and remote clients use one process-stop command with deterministic graceful cleanup.

## Module interface

A shutdown coordinator accepts one process-shutdown request, rejects new work after acceptance,
closes the listener after the response is committed, applies the cleanup deadline, and reports the
exit outcome. HTTP routes and process signals call the same coordinator.

The coordinator owns process shutdown, while `CocodRuntime` continues to own Coco Session cleanup.

## Includes

- Add `POST /v1/admin/process/stop` and update `cocod stop` to use it.
- Extend the runtime schemas and generated interface description with process shutdown.
- Return `202` before closing the listener and reject new work after acceptance.
- Replace the hard-coded three-second deadline with a configurable 30-second default shared by
  explicit Coco Session shutdown and process termination.
- Exit zero after confirmed cleanup and non-zero after unconfirmed cleanup.
- Remove the legacy `/stop` route.

## Excludes

- Process-supervisor configuration.
- A promise that the deployment remains stopped.
- Transport-specific lifecycle rules.

## Acceptance

- Response-before-close and concurrent shutdown behavior are covered.
- Cleanup deadline and exit status behavior are deterministic.
- Client disconnect does not cancel an accepted shutdown.
- Network requests and process signals exercise the same shutdown coordinator.
