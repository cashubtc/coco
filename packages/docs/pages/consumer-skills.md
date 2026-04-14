# Consumer Skills

This repository uses two different skill locations for two different audiences.

## Internal Repo Skills

Repo-local maintainer skills live in `.agents/skills/`.

Use this location for workflows that help an agent work on `coco-cashu` itself, for example:

- drafting pull request summaries
- checking contributor-specific release steps
- enforcing repo-specific engineering workflows

These skills are internal project tooling. They are not the right place for assets you expect Coco consumers to discover and install for their own use.

## Consumer-Facing Skills

Consumer-facing skills should live in a top-level `skills/` directory:

```text
skills/
  <skill-name>/
    SKILL.md
```

If you expect multiple audiences, group them explicitly:

```text
skills/
  consumers/
    <skill-name>/
  integrators/
    <skill-name>/
```

This keeps installable skills separate from internal repo machinery and makes them easier to document, publish, and discover.

## Recommendation

Use this split consistently:

- `.agents/skills/` for contributor and maintainer workflows inside this repository
- `skills/` for public, consumer-focused skills shipped from this repository

That separation keeps ownership and intent clear:

- hidden-ish repo automation stays under `.agents/`
- public skills live in a stable, obvious path at the repository root

## Documenting Consumer Skills

When you add public skills under `skills/`, document them as product artifacts:

- explain who the skill is for
- describe required packages or environment assumptions
- include a minimal usage example
- link back to the relevant Coco package or guide in these docs
