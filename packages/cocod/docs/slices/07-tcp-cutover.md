# Slice 7: TCP Cutover

Depends on [Slice 5](./05-wallet-recovery-material-export.md) and
[Slice 6](./06-authenticated-process-shutdown.md).

## Outcome

Cocod exposes exactly one authenticated TCP interface and no Unix listener.

## Adapter swap

This slice replaces the transport adapter beneath the already-tested route interface. It must not
change credential, lifecycle, Wallet Recovery Material, or shutdown semantics.

## Includes

- Bind explicitly to `127.0.0.1:62626` by default with validated `COCOD_LISTEN_HOST` and
  `COCOD_LISTEN_PORT` overrides.
- Serve v1 resources and authenticated legacy command routes on the same listener.
- Replace Unix request setup in normal and streaming CLI paths with one configured HTTP client.
- Use the local default and auto-start only when no endpoint is specified; make `--url` and
  `COCOD_URL` client-only.
- Remove `COCOD_SOCKET`, socket probing, and Unix-listener documentation.
- Fail clearly when host-local commands are requested for an explicit remote endpoint.
- Keep CORS disabled and document Caddy or an equivalent trusted proxy for remote TLS.

## Excludes

- Native TLS.
- Multiple listeners or a compatibility socket.
- Browser clients.
- Redesigning legacy wallet routes.

## Acceptance

- Local auto-start and explicit remote mode pass integration tests.
- Authenticated normal and streaming legacy commands work over TCP.
- Process shutdown works locally and remotely through the same resource.
- Bind failures and explicit non-loopback configuration are covered.
- No Unix socket is created and no runtime path references `COCOD_SOCKET`.
