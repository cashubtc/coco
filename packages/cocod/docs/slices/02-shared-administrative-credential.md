# Slice 2: Shared Administrative Credential

Depends on [Slice 1](./01-contract-and-decisions.md).

## Outcome

The current Unix HTTP interface is authenticated through one deep credential module before the
transport changes.

## Module interface

Daemon startup asks the credential module to load or bootstrap the single administrative Client
Credential. Route execution asks the same module to authorize a presented bearer credential for a
Client Capability. The module hides token generation, verifier storage, constant-time comparison,
file validation, and rotation.

This is one concrete, opinionated implementation. Do not introduce a credential adapter seam for
hypothetical future stores.

## Includes

- Automatically bootstrap one opaque administrative Client Credential before listener bind.
- Store a verifier in daemon state and the plaintext credential in a distinct mode-`0600` local
  client file.
- Load, validate, verify, and host-locally rotate the credential atomically.
- Add `wallet:read` and `wallet:admin` policy to route metadata and enforce it centrally.
- Make the CLI read the credential file and attach `Authorization: Bearer` to every protected
  request, including streaming requests.
- Keep only the minimal health probe unauthenticated.
- Return generic `401` and `403` failures without logging credentials or authorization headers.

## Excludes

- TCP transport.
- Multiple Client Credentials, client enrollment, or per-client revocation.
- Browser support.
- New v1 lifecycle resources.

## Acceptance

- Bootstrap, restart, corrupt-state, and missing-client-file scenarios are covered.
- Authentication, capability, rotation, file-mode, and redaction tests pass.
- Normal and streaming CLI requests send the credential.
- The tests exercise authorization through the module interface and the Unix listener.
