# Slice 1: Contract and Decisions

Status: complete in the current worktree; not yet committed.

## Outcome

Reviewers can accept the security, lifecycle, Wallet Recovery Material, and transport contract
without reviewing runtime code.

## Includes

- Update the Cocod Host and Coco Cashu glossaries.
- Specify the lifecycle and network interface in
  [network-interface-v1.md](../network-interface-v1.md).
- Record the accepted authentication, Wallet Recovery Material, and TCP decisions in
  [Cocod Host ADRs](../adr/).
- Define the dependency-ordered delivery slices in this directory.

## Excludes

- Runtime behavior changes.
- Package interface or persisted-data changes.
- A release changeset.

## Acceptance

- The specification contains no unresolved lifecycle decisions.
- Glossary terms agree with the specification and ADRs.
- Every later slice has one outcome, explicit exclusions, dependencies, and an acceptance gate.
- Prettier and `git diff --check` pass.
