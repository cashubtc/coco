---
status: accepted
---

# Bootstrap authentication from the trusted host

Each Cocod Process has one Cocod Owner, and v1 automatically creates one opaque, high-entropy
administrative Client Credential before binding its TCP listener. The daemon retains only a
verifier, while the local CLI keeps the plaintext credential in a mode-`0600` client file; several
Cocod Clients may share it. The credential grants `wallet:read` and `wallet:admin`, and rotation is
host-local. This keeps first start unattended and avoids an unauthenticated network bootstrap at
the accepted cost of having no per-client identity, audit attribution, or revocation in v1.

Cocod authenticates the credential itself. It binds to loopback by default and does not implement
native TLS in v1; remote deployments use a trusted TLS proxy such as Caddy, which supplies transport
security but does not assert client identity. Individual Client Credentials and network credential
management are deferred.
