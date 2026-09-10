# Consumer Skills

Coco ships agent skills for developers building wallets in their own applications.

## Browser wallets

[`coco-browser-wallet`](https://github.com/cashubtc/coco/tree/master/skills/coco-browser-wallet)
guides an agent through browser session setup, Wallet Seed handling, mint trust, balances,
ecash send/receive, Lightning payments, and resuming interrupted operations. It includes a
separate reference for React providers and operation hooks.

The skill uses `@cashu/coco-core` and `@cashu/coco-indexeddb`, with optional
`@cashu/coco-react` bindings. It works with the app's existing framework and package manager,
and directs the agent to check installed API versions and peer dependencies. Browser storage
and wallet initialization run on the client. The app supplies seed storage and an unlock flow;
the skill distinguishes demo helpers from real-funds integration.

## Install

From your application directory, install the selected skill with the
[Skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add cashubtc/coco --skill coco-browser-wallet
```

For a local Coco checkout, including a branch containing unpublished skill changes:

```bash
npx skills add /path/to/coco/skills/coco-browser-wallet
```

Alternatively, copy the entire `skills/coco-browser-wallet/` folder into your agent's skill
directory. Keep `references/` alongside `SKILL.md` so the installed skill remains self-contained.
Installing the skill does not install Coco's npm packages.

## Use

Ask your agent to use the installed skill, for example:

> Use coco-browser-wallet to add a Cashu wallet to this React app. Use IndexedDB and our
> existing unlock flow. Add mint selection, balances, ecash send/receive, and BOLT11 payments.
> Show fees before confirmation and resume pending operations after reload.

The skill can also be selected automatically by agents that support matching task descriptions.
For direct API documentation, see [Storage Adapters](./storage-adapters.md),
[Sending and Receiving](../starting/sending-receiving.md), and
[React Providers](./react-providers.md).

## Contributing skills

Consumer-facing skills live at `skills/<skill-name>/SKILL.md` in the repository root. Keep
conditional references inside the skill folder so consumers can install it independently.
Document each public skill here with its audience, environment assumptions, and a usage example.

Contributor and maintainer workflows live separately in `.agents/skills/`.
