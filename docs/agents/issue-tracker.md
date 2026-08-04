# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`.
- **Read an issue**: `gh issue view <number> --comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments`.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply/remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close an issue**: `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

External pull requests do not enter the `/triage` issue queue. GitHub shares one number
space across issues and pull requests, so resolve ambiguous references with
`gh pr view <number>` and fall back to `gh issue view <number>`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. A map is one issue whose tickets are native GitHub sub-issues.

- **Map**: create an issue labelled `wayfinder:map`. Its body contains Destination,
  Notes, Decisions so far, Not yet specified, and Out of scope.
- **Child ticket**: create the issue with its `wayfinder:<type>` label, obtain its
  numeric database ID, and attach it to the map:

  ```bash
  child_db_id="$(gh api repos/<owner>/<repo>/issues/<child> --jq .id)"
  gh api --method POST \
    repos/<owner>/<repo>/issues/<map>/sub_issues \
    -F sub_issue_id="$child_db_id"
  ```

  Verify the relationship with:

  ```bash
  gh api repos/<owner>/<repo>/issues/<map>/sub_issues \
    --jq '.[] | [.number, .title] | @tsv'
  ```

  If native sub-issues are unavailable, add the child to a task list in the map body
  and put `Part of #<map>` at the top of the child body.

- **Blocking**: add a native dependency after all involved issues exist:

  ```bash
  blocker_db_id="$(gh api repos/<owner>/<repo>/issues/<blocker> --jq .id)"
  gh api --method POST \
    repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by \
    -F issue_id="$blocker_db_id"
  ```

  Verify it with:

  ```bash
  gh api repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by \
    --jq '.[] | [.number, .title] | @tsv'
  ```

  If native dependencies are unavailable, put `Blocked by: #<number>` near the top
  of the child body.

- **Frontier query**: list the map's open sub-issues in map order. Exclude tickets
  with an assignee or any open `blocked_by` dependency. The remaining tickets form
  the frontier; the first is selected by default.
- **Claim**: run `gh issue edit <number> --add-assignee @me` before beginning work.
- **Resolve**: post the answer with `gh issue comment`, close the ticket, and append
  a linked one-line gist to the map's Decisions-so-far section.
