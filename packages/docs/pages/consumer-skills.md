# Consumer Skills

Coco ships agent skills for developers building wallets in their own applications. Shared wallet
behavior lives in one general skill; platform skills add runtime-specific setup and verification.

## Available skills

| Skill                                                                                            | Use it for                                                                                                                               |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [`coco-wallet`](https://github.com/cashubtc/coco/tree/master/skills/coco-wallet)                 | Wallet identity, public APIs, mint trust, amounts, ecash, Lightning and onchain flows, and Operation Recovery on any platform.           |
| [`coco-browser-wallet`](https://github.com/cashubtc/coco/tree/master/skills/coco-browser-wallet) | Browser setup with IndexedDB, client-only initialization, tab ownership, and optional React providers and hooks. Requires `coco-wallet`. |

`coco-wallet` can be used on its own with the target runtime's adapter documentation. The browser
skill explicitly loads that shared workflow and supplies the browser requirements. The general
skill routes to separate references for ecash send, ecash receive, BOLT11, BOLT12, onchain,
payment requests, P2PK, and Restore. Agents load only the requested flows; wallet basics and
quote-lifecycle rules each have one shared reference. React guidance belongs to the browser skill.

Both skills work with the app's existing framework and package manager and direct the agent to
check installed API versions and peer dependencies. Browser apps use `@cashu/coco-core` and
`@cashu/coco-indexeddb`, with optional `@cashu/coco-react` bindings. The app supplies seed storage
and an unlock flow; browser storage and wallet initialization run on the client.

## Install

From your application directory, install the general skill with the
[Skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add cashubtc/coco --skill coco-wallet
```

For browser apps, install both skills:

```bash
npx skills add cashubtc/coco --skill coco-wallet --skill coco-browser-wallet
```

For a local Coco checkout, including a branch containing unpublished skill changes:

```bash
npx skills add /path/to/coco/skills --skill coco-wallet --skill coco-browser-wallet
```

Install or update the pair from the same Coco revision. Selecting only the browser skill does
not automatically install its shared dependency.

Alternatively, copy the complete `skills/coco-wallet/` folder into your agent's skill directory.
For browser apps, also copy `skills/coco-browser-wallet/` beside it. Keep each skill's `references/`
folder alongside its `SKILL.md`. The browser skill resolves the general skill by its installed
name or sibling path; neither requires the rest of the Coco repository.

Installing skills does not install Coco's npm packages.

## Use

Ask your agent to use the browser skill, which loads the general workflow:

> Use coco-browser-wallet to add a Cashu wallet to this React app. Use IndexedDB and our
> existing unlock flow. Add mint selection, balances, ecash send/receive, and BOLT11 payments.
> Show fees before confirmation and resume pending operations after reload.

For an app with runtime setup already in place:

> Use coco-wallet to add fee review and resume support to our existing ecash send flow.

The skills can also be selected automatically by agents that support matching task descriptions.
For direct API documentation, see [Storage Adapters](./storage-adapters.md),
[Sending and Receiving](../starting/sending-receiving.md), and
[React Providers](./react-providers.md).

## Contributing skills

Consumer-facing skills live at `skills/<skill-name>/SKILL.md` in the repository root. Keep common
wallet behavior in `coco-wallet` and its references. A new platform skill should load that skill
and document its adapter, environment, lifecycle, and runtime checks. Keep conditional references
inside the skill that owns them, and document required companion skills and installation here.

Contributor and maintainer workflows live separately in `.agents/skills/`.
