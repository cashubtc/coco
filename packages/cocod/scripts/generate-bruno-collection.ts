import { mkdir } from 'node:fs/promises';
import { dirname, relative } from 'node:path';

type Method = 'GET' | 'POST';

type ContractRoute = {
  method: Method;
  path: string;
  capability: 'wallet:read' | 'wallet:admin' | null;
  requestSchema: string | null;
  responseSchema: string;
  successStatuses: number[];
  idempotencyKey: 'optional' | null;
  responseCacheControl: 'no-store' | null;
};

type InterfaceDescription = {
  version: string;
  interfaceVersion: string;
  routes: ContractRoute[];
};

type QueryParameter = {
  name: string;
  value: string;
  enabled?: boolean;
};

type RequestDefinition = {
  name: string;
  method: Method;
  path: string;
  group: string;
  description: string;
  tags: string[];
  query?: QueryParameter[];
  body?: Record<string, unknown>;
  capture?: string;
  variant?: string;
};

const collectionPath = new URL('../bruno/', import.meta.url);
const interfacePath = new URL('../docs/lifecycle-api-v1.json', import.meta.url);

const groupSequence = new Map([
  ['Process and Status', 1],
  ['Wallet Lifecycle', 2],
  ['Balances', 3],
  ['Known Mints', 4],
  ['Payment Requests', 5],
  ['Mint Quotes', 6],
  ['Melt Quotes', 7],
  ['Mint Operations', 8],
  ['Melt Operations', 9],
  ['Send Operations', 10],
  ['Receive Operations', 11],
  ['History', 12],
  ['Legacy Compatibility', 90],
  ['Proposed Resources', 99],
]);

const page = (): QueryParameter[] => [
  { name: 'offset', value: '{{offset}}' },
  { name: 'limit', value: '{{limit}}' },
];

const mintUrl = (): QueryParameter[] => [{ name: 'mintUrl', value: '{{mintUrl}}' }];

const json = (value: Record<string, unknown>) => value;

const implementedRequests: RequestDefinition[] = [
  {
    name: 'Health',
    method: 'GET',
    path: '/health',
    group: 'Process and Status',
    description: 'Public process-liveness check. It intentionally reveals no Wallet state.',
    tags: ['safe', 'public'],
  },
  {
    name: 'Lifecycle Status',
    method: 'GET',
    path: '/v1/status',
    group: 'Process and Status',
    description: 'Read Wallet configuration, Wallet Seed Access, and Coco Session state.',
    tags: ['safe', 'lifecycle'],
  },
  {
    name: 'Evaluate Payment Request',
    method: 'POST',
    path: '/v1/payment-requests/evaluate',
    group: 'Payment Requests',
    description: 'Parse an outgoing Payment Request without preparing or executing a payment.',
    tags: ['safe', 'sensitive'],
    body: json({ request: '{{paymentRequest}}' }),
  },
  {
    name: 'List Balances',
    method: 'GET',
    path: '/v1/balances',
    group: 'Balances',
    description: 'Return spendable, reserved, and total balances by Mint and unit.',
    tags: ['safe', 'wallet'],
    query: [
      { name: 'mintUrl', value: '{{mintUrl}}', enabled: false },
      { name: 'unit', value: '{{unit}}', enabled: false },
      { name: 'trustedOnly', value: '{{trustedOnly}}', enabled: false },
    ],
  },
  {
    name: 'List History',
    method: 'GET',
    path: '/v1/history',
    group: 'History',
    description: 'Return an offset-paginated, newest-first projection of safe Wallet history.',
    tags: ['safe', 'wallet'],
    query: page(),
    capture:
      "if (res.status === 200 && res.body.items?.[0]?.id) bru.setVar('historyEntryId', res.body.items[0].id);",
  },
  {
    name: 'Get History Entry',
    method: 'GET',
    path: '/v1/history/{historyEntryId}',
    group: 'History',
    description: 'Return one safe History Entry by its direct Coco identity.',
    tags: ['safe', 'wallet'],
  },
  {
    name: 'List Known Mints',
    method: 'GET',
    path: '/v1/mints',
    group: 'Known Mints',
    description: 'List Known Mints, optionally limiting the response to trusted Mints.',
    tags: ['safe', 'wallet'],
    query: [{ name: 'trustedOnly', value: '{{trustedOnly}}', enabled: false }],
  },
  {
    name: 'Register Known Mint',
    method: 'POST',
    path: '/v1/mints',
    group: 'Known Mints',
    description: 'Discover and persist a Known Mint without implicitly trusting it.',
    tags: ['mutation', 'wallet'],
    body: json({ mintUrl: '{{mintUrl}}' }),
  },
  {
    name: 'Trust Known Mint',
    method: 'POST',
    path: '/v1/mints/trust',
    group: 'Known Mints',
    description: 'Allow Wallet operations through a previously registered Known Mint.',
    tags: ['mutation', 'wallet'],
    body: json({ mintUrl: '{{mintUrl}}' }),
  },
  {
    name: 'Untrust Known Mint',
    method: 'POST',
    path: '/v1/mints/untrust',
    group: 'Known Mints',
    description: 'Remove trust from a Known Mint without forgetting it.',
    tags: ['mutation', 'wallet'],
    body: json({ mintUrl: '{{mintUrl}}' }),
  },
  {
    name: 'Get Mint Info',
    method: 'GET',
    path: '/v1/mints/info',
    group: 'Known Mints',
    description: 'Resolve current Mint metadata through Coco.',
    tags: ['safe', 'wallet'],
    query: mintUrl(),
  },
  {
    name: 'Get Payment Method Capabilities',
    method: 'GET',
    path: '/v1/mints/payment-method-capabilities',
    group: 'Known Mints',
    description: 'List the Mint and Melt methods and units advertised by a Mint.',
    tags: ['safe', 'wallet'],
    query: mintUrl(),
  },
  {
    name: 'Create BOLT11 Mint Quote',
    method: 'POST',
    path: '/v1/quotes/mint',
    group: 'Mint Quotes',
    description: 'Create a BOLT11 Mint Quote. This does not create a Mint Operation.',
    tags: ['mutation', 'financial'],
    body: json({
      mintUrl: '{{mintUrl}}',
      method: 'bolt11',
      amount: '{{amount}}',
      unit: '{{unit}}',
    }),
    capture: "if (res.status === 201) bru.setVar('mintQuoteId', res.body.quoteId);",
  },
  {
    name: 'Create BOLT12 Mint Quote',
    method: 'POST',
    path: '/v1/quotes/mint',
    group: 'Mint Quotes',
    description: 'Create a BOLT12 Mint Quote. This does not create a Mint Operation.',
    tags: ['mutation', 'financial'],
    variant: 'bolt12',
    body: json({
      mintUrl: '{{mintUrl}}',
      method: 'bolt12',
      unit: '{{unit}}',
      amount: '{{amount}}',
      description: '{{quoteDescription}}',
    }),
    capture: "if (res.status === 201) bru.setVar('mintQuoteId', res.body.quoteId);",
  },
  {
    name: 'Create On-chain Mint Quote',
    method: 'POST',
    path: '/v1/quotes/mint',
    group: 'Mint Quotes',
    description: 'Create an on-chain Mint Quote. This does not create a Mint Operation.',
    tags: ['mutation', 'financial'],
    variant: 'onchain',
    body: json({ mintUrl: '{{mintUrl}}', method: 'onchain', unit: '{{unit}}' }),
    capture: "if (res.status === 201) bru.setVar('mintQuoteId', res.body.quoteId);",
  },
  {
    name: 'List Pending Mint Quotes',
    method: 'GET',
    path: '/v1/quotes/mint/pending',
    group: 'Mint Quotes',
    description: 'List pending Mint Quotes with optional method filtering.',
    tags: ['safe', 'financial'],
    query: [{ name: 'method', value: '{{method}}', enabled: false }, ...page()],
  },
  {
    name: 'Get Mint Quote',
    method: 'GET',
    path: '/v1/quotes/mint/{quoteId}',
    group: 'Mint Quotes',
    description: 'Read canonical local state for a Mint Quote.',
    tags: ['safe', 'financial'],
    query: mintUrl(),
  },
  {
    name: 'Refresh Mint Quote',
    method: 'POST',
    path: '/v1/quotes/mint/{quoteId}/refresh',
    group: 'Mint Quotes',
    description: 'Explicitly reconcile a Mint Quote with its Mint.',
    tags: ['mutation', 'financial'],
    query: mintUrl(),
  },
  {
    name: 'Create BOLT11 Melt Quote',
    method: 'POST',
    path: '/v1/quotes/melt',
    group: 'Melt Quotes',
    description: 'Create a BOLT11 Melt Quote without preparing or executing a Melt Operation.',
    tags: ['mutation', 'financial', 'sensitive'],
    body: json({ mintUrl: '{{mintUrl}}', method: 'bolt11', invoice: '{{bolt11Invoice}}' }),
    capture: "if (res.status === 201) bru.setVar('meltQuoteId', res.body.quoteId);",
  },
  {
    name: 'Create BOLT12 Melt Quote',
    method: 'POST',
    path: '/v1/quotes/melt',
    group: 'Melt Quotes',
    description: 'Create a BOLT12 Melt Quote without preparing or executing a Melt Operation.',
    tags: ['mutation', 'financial', 'sensitive'],
    variant: 'bolt12',
    body: json({ mintUrl: '{{mintUrl}}', method: 'bolt12', offer: '{{bolt12Offer}}' }),
    capture: "if (res.status === 201) bru.setVar('meltQuoteId', res.body.quoteId);",
  },
  {
    name: 'Create On-chain Melt Quote',
    method: 'POST',
    path: '/v1/quotes/melt',
    group: 'Melt Quotes',
    description: 'Create an on-chain Melt Quote without preparing or executing a Melt Operation.',
    tags: ['mutation', 'financial', 'sensitive'],
    variant: 'onchain',
    body: json({
      mintUrl: '{{mintUrl}}',
      method: 'onchain',
      address: '{{onchainAddress}}',
      amount: '{{amount}}',
      unit: '{{unit}}',
    }),
    capture: "if (res.status === 201) bru.setVar('meltQuoteId', res.body.quoteId);",
  },
  {
    name: 'List Pending Melt Quotes',
    method: 'GET',
    path: '/v1/quotes/melt/pending',
    group: 'Melt Quotes',
    description: 'List pending Melt Quotes with optional method filtering.',
    tags: ['safe', 'financial'],
    query: [{ name: 'method', value: '{{method}}', enabled: false }, ...page()],
  },
  {
    name: 'Get Melt Quote',
    method: 'GET',
    path: '/v1/quotes/melt/{quoteId}',
    group: 'Melt Quotes',
    description: 'Read canonical local state for a Melt Quote.',
    tags: ['safe', 'financial'],
    query: mintUrl(),
  },
  {
    name: 'Refresh Melt Quote',
    method: 'POST',
    path: '/v1/quotes/melt/{quoteId}/refresh',
    group: 'Melt Quotes',
    description: 'Explicitly reconcile a Melt Quote with its Mint.',
    tags: ['mutation', 'financial'],
    query: mintUrl(),
  },
  {
    name: 'Prepare Mint Operation',
    method: 'POST',
    path: '/v1/operations/mint',
    group: 'Mint Operations',
    description: 'Prepare a durable Mint Operation from a paid Mint Quote.',
    tags: ['mutation', 'financial'],
    body: json({ mintUrl: '{{mintUrl}}', quoteId: '{{mintQuoteId}}', amount: '{{amount}}' }),
    capture: "if (res.status === 201) bru.setVar('mintOperationId', res.body.id);",
  },
  {
    name: 'List Pending Mint Operations',
    method: 'GET',
    path: '/v1/operations/mint/pending',
    group: 'Mint Operations',
    description: 'List pending Mint Operations.',
    tags: ['safe', 'financial'],
    query: page(),
  },
  {
    name: 'List In-flight Mint Operations',
    method: 'GET',
    path: '/v1/operations/mint/in-flight',
    group: 'Mint Operations',
    description: 'List in-flight Mint Operations.',
    tags: ['safe', 'financial'],
    query: page(),
  },
  {
    name: 'Get Mint Operation',
    method: 'GET',
    path: '/v1/operations/mint/{operationId}',
    group: 'Mint Operations',
    description: 'Inspect safe state and preparation data for a Mint Operation.',
    tags: ['safe', 'financial'],
  },
  {
    name: 'Execute Mint Operation',
    method: 'POST',
    path: '/v1/operations/mint/{operationId}/execute',
    group: 'Mint Operations',
    description: 'Execute or resume a prepared Mint Operation.',
    tags: ['mutation', 'financial'],
  },
  {
    name: 'Get Mint Operation Result (Unsupported)',
    method: 'GET',
    path: '/v1/operations/mint/{operationId}/result',
    group: 'Mint Operations',
    description: 'Mint has no distinct result resource in v1; this route returns not_found.',
    tags: ['safe', 'unsupported'],
  },
  {
    name: 'Refresh Mint Operation',
    method: 'POST',
    path: '/v1/operations/mint/{operationId}/refresh',
    group: 'Mint Operations',
    description: 'Reconcile persisted, Wallet, and remote Mint Operation state.',
    tags: ['mutation', 'financial'],
  },
  {
    name: 'Prepare Melt Operation',
    method: 'POST',
    path: '/v1/operations/melt',
    group: 'Melt Operations',
    description: 'Prepare and reserve proofs for a quote-backed Melt Operation.',
    tags: ['mutation', 'financial'],
    body: json({ mintUrl: '{{mintUrl}}', quoteId: '{{meltQuoteId}}' }),
    capture: "if (res.status === 201) bru.setVar('meltOperationId', res.body.id);",
  },
  {
    name: 'List Prepared Melt Operations',
    method: 'GET',
    path: '/v1/operations/melt/prepared',
    group: 'Melt Operations',
    description: 'List prepared Melt Operations.',
    tags: ['safe', 'financial'],
    query: page(),
  },
  {
    name: 'List In-flight Melt Operations',
    method: 'GET',
    path: '/v1/operations/melt/in-flight',
    group: 'Melt Operations',
    description: 'List executing and pending Melt Operations exposed by Coco.',
    tags: ['safe', 'financial'],
    query: page(),
  },
  {
    name: 'Get Melt Operation',
    method: 'GET',
    path: '/v1/operations/melt/{operationId}',
    group: 'Melt Operations',
    description: 'Inspect safe state and preparation data for a Melt Operation.',
    tags: ['safe', 'financial'],
  },
  {
    name: 'Execute Melt Operation',
    method: 'POST',
    path: '/v1/operations/melt/{operationId}/execute',
    group: 'Melt Operations',
    description: 'Execute or resume a prepared Melt Operation; may return a sensitive result.',
    tags: ['mutation', 'financial', 'sensitive'],
  },
  {
    name: 'Get Melt Operation Result',
    method: 'GET',
    path: '/v1/operations/melt/{operationId}/result',
    group: 'Melt Operations',
    description: 'Recover the sensitive terminal result retained by Coco.',
    tags: ['safe', 'financial', 'sensitive'],
  },
  {
    name: 'Cancel Melt Operation',
    method: 'POST',
    path: '/v1/operations/melt/{operationId}/cancel',
    group: 'Melt Operations',
    description: 'Cancel a Melt Operation before irreversible execution when supported.',
    tags: ['mutation', 'financial'],
  },
  {
    name: 'Refresh Melt Operation',
    method: 'POST',
    path: '/v1/operations/melt/{operationId}/refresh',
    group: 'Melt Operations',
    description: 'Reconcile persisted, Wallet, and remote Melt Operation state.',
    tags: ['mutation', 'financial'],
  },
  {
    name: 'Reclaim Melt Operation',
    method: 'POST',
    path: '/v1/operations/melt/{operationId}/reclaim',
    group: 'Melt Operations',
    description: 'Reclaim a pending Melt when Coco determines doing so is safe.',
    tags: ['mutation', 'financial'],
  },
  {
    name: 'Prepare Cashu Send',
    method: 'POST',
    path: '/v1/operations/send',
    group: 'Send Operations',
    description: 'Prepare a Cashu Send Operation without executing it.',
    tags: ['mutation', 'financial'],
    body: json({
      mintUrl: '{{mintUrl}}',
      amount: '{{amount}}',
      unit: '{{unit}}',
      forceSwap: false,
    }),
    capture: "if (res.status === 201) bru.setVar('sendOperationId', res.body.id);",
  },
  {
    name: 'Prepare Payment Request Send',
    method: 'POST',
    path: '/v1/operations/send',
    group: 'Send Operations',
    description: 'Prepare an in-band Payment Request Send without executing it.',
    tags: ['mutation', 'financial', 'sensitive'],
    variant: 'payment-request',
    body: json({
      mintUrl: '{{mintUrl}}',
      source: { type: 'payment-request', request: '{{paymentRequest}}' },
    }),
    capture: "if (res.status === 201) bru.setVar('sendOperationId', res.body.id);",
  },
  {
    name: 'Prepare Payment Request Send with Amount',
    method: 'POST',
    path: '/v1/operations/send',
    group: 'Send Operations',
    description: 'Prepare an in-band Payment Request Send with an explicit amount override.',
    tags: ['mutation', 'financial', 'sensitive'],
    variant: 'payment-request-amount',
    body: json({
      mintUrl: '{{mintUrl}}',
      source: { type: 'payment-request', request: '{{paymentRequest}}' },
      amount: '{{amount}}',
      unit: '{{unit}}',
    }),
    capture: "if (res.status === 201) bru.setVar('sendOperationId', res.body.id);",
  },
  {
    name: 'List Prepared Send Operations',
    method: 'GET',
    path: '/v1/operations/send/prepared',
    group: 'Send Operations',
    description: 'List prepared Send Operations.',
    tags: ['safe', 'financial'],
    query: page(),
  },
  {
    name: 'List In-flight Send Operations',
    method: 'GET',
    path: '/v1/operations/send/in-flight',
    group: 'Send Operations',
    description: 'List in-flight Send Operations.',
    tags: ['safe', 'financial'],
    query: page(),
  },
  {
    name: 'Get Send Operation',
    method: 'GET',
    path: '/v1/operations/send/{operationId}',
    group: 'Send Operations',
    description: 'Inspect safe state and preparation data for a Send Operation.',
    tags: ['safe', 'financial'],
  },
  {
    name: 'Execute Send Operation',
    method: 'POST',
    path: '/v1/operations/send/{operationId}/execute',
    group: 'Send Operations',
    description: 'Execute a prepared Send and return its sensitive outgoing token.',
    tags: ['mutation', 'financial', 'sensitive'],
  },
  {
    name: 'Get Send Operation Result',
    method: 'GET',
    path: '/v1/operations/send/{operationId}/result',
    group: 'Send Operations',
    description: 'Recover the sensitive outgoing token retained by Coco.',
    tags: ['safe', 'financial', 'sensitive'],
  },
  {
    name: 'Cancel Send Operation',
    method: 'POST',
    path: '/v1/operations/send/{operationId}/cancel',
    group: 'Send Operations',
    description: 'Cancel a Send Operation before irreversible execution when supported.',
    tags: ['mutation', 'financial'],
  },
  {
    name: 'Refresh Send Operation',
    method: 'POST',
    path: '/v1/operations/send/{operationId}/refresh',
    group: 'Send Operations',
    description: 'Reconcile persisted, Wallet, and remote Send Operation state.',
    tags: ['mutation', 'financial'],
  },
  {
    name: 'Reclaim Send Operation',
    method: 'POST',
    path: '/v1/operations/send/{operationId}/reclaim',
    group: 'Send Operations',
    description: 'Reclaim a pending Send when Coco determines doing so is safe.',
    tags: ['mutation', 'financial'],
  },
  {
    name: 'Prepare Cashu Receive',
    method: 'POST',
    path: '/v1/operations/receive',
    group: 'Receive Operations',
    description: 'Prepare a Cashu Receive Operation without executing it.',
    tags: ['mutation', 'financial', 'sensitive'],
    body: json({ token: '{{cashuToken}}' }),
    capture: "if (res.status === 201) bru.setVar('receiveOperationId', res.body.id);",
  },
  {
    name: 'List Prepared Receive Operations',
    method: 'GET',
    path: '/v1/operations/receive/prepared',
    group: 'Receive Operations',
    description: 'List prepared Receive Operations.',
    tags: ['safe', 'financial'],
    query: page(),
  },
  {
    name: 'List In-flight Receive Operations',
    method: 'GET',
    path: '/v1/operations/receive/in-flight',
    group: 'Receive Operations',
    description: 'List in-flight Receive Operations.',
    tags: ['safe', 'financial'],
    query: page(),
  },
  {
    name: 'Get Receive Operation',
    method: 'GET',
    path: '/v1/operations/receive/{operationId}',
    group: 'Receive Operations',
    description: 'Inspect safe state and preparation data for a Receive Operation.',
    tags: ['safe', 'financial'],
  },
  {
    name: 'Execute Receive Operation',
    method: 'POST',
    path: '/v1/operations/receive/{operationId}/execute',
    group: 'Receive Operations',
    description: 'Execute or resume a prepared Receive Operation.',
    tags: ['mutation', 'financial'],
  },
  {
    name: 'Get Receive Operation Result (Unsupported)',
    method: 'GET',
    path: '/v1/operations/receive/{operationId}/result',
    group: 'Receive Operations',
    description: 'Receive has no distinct result resource in v1; this route returns not_found.',
    tags: ['safe', 'unsupported'],
  },
  {
    name: 'Cancel Receive Operation',
    method: 'POST',
    path: '/v1/operations/receive/{operationId}/cancel',
    group: 'Receive Operations',
    description: 'Cancel a Receive Operation before irreversible execution when supported.',
    tags: ['mutation', 'financial'],
  },
  {
    name: 'Refresh Receive Operation',
    method: 'POST',
    path: '/v1/operations/receive/{operationId}/refresh',
    group: 'Receive Operations',
    description: 'Reconcile persisted, Wallet, and remote Receive Operation state.',
    tags: ['mutation', 'financial'],
  },
  {
    name: 'Initialize Wallet (Unattended)',
    method: 'POST',
    path: '/v1/admin/wallet/initialize',
    group: 'Wallet Lifecycle',
    description: 'Generate a Wallet with unattended Coco Session startup and return its mnemonic.',
    tags: ['mutation', 'lifecycle', 'sensitive'],
    body: json({}),
  },
  {
    name: 'Initialize Wallet (Protected)',
    method: 'POST',
    path: '/v1/admin/wallet/initialize',
    group: 'Wallet Lifecycle',
    description: 'Generate a passphrase-protected Wallet and return its mnemonic.',
    tags: ['mutation', 'lifecycle', 'sensitive'],
    variant: 'protected',
    body: json({ passphrase: '{{walletPassphrase}}' }),
  },
  {
    name: 'Get Recovery Material (Unattended)',
    method: 'POST',
    path: '/v1/admin/wallet/recovery-material',
    group: 'Wallet Lifecycle',
    description: 'Retrieve Wallet Recovery Material for a Wallet without a passphrase.',
    tags: ['sensitive', 'lifecycle'],
    body: json({}),
  },
  {
    name: 'Get Recovery Material (Protected)',
    method: 'POST',
    path: '/v1/admin/wallet/recovery-material',
    group: 'Wallet Lifecycle',
    description: 'Decrypt and retrieve Wallet Recovery Material for this response only.',
    tags: ['sensitive', 'lifecycle'],
    variant: 'protected',
    body: json({ passphrase: '{{walletPassphrase}}' }),
  },
  {
    name: 'Start Session (Unattended)',
    method: 'POST',
    path: '/v1/admin/session/start',
    group: 'Wallet Lifecycle',
    description: 'Start the Coco Session for a Wallet without a passphrase.',
    tags: ['mutation', 'lifecycle'],
    body: json({}),
  },
  {
    name: 'Start Session (Protected)',
    method: 'POST',
    path: '/v1/admin/session/start',
    group: 'Wallet Lifecycle',
    description: 'Unlock Wallet Seed Access and start the Coco Session.',
    tags: ['mutation', 'lifecycle', 'sensitive'],
    variant: 'protected',
    body: json({ passphrase: '{{walletPassphrase}}' }),
  },
  {
    name: 'Stop Session',
    method: 'POST',
    path: '/v1/admin/session/stop',
    group: 'Wallet Lifecycle',
    description: 'Stop Wallet work and dispose the Coco Session.',
    tags: ['mutation', 'lifecycle'],
    body: json({}),
  },
  {
    name: 'Stop Cocod Process',
    method: 'POST',
    path: '/v1/admin/process/stop',
    group: 'Process and Status',
    description: 'Request graceful process termination. A supervisor may restart it.',
    tags: ['mutation', 'lifecycle', 'shutdown'],
    body: json({}),
  },
];

const compatibilityRequests: RequestDefinition[] = [
  {
    name: 'Legacy Event Stream',
    method: 'GET',
    path: '/events',
    group: 'Legacy Compatibility',
    description: 'Authenticated legacy SSE stream retained until /v1/events is implemented.',
    tags: ['legacy', 'stream'],
  },
  {
    name: 'NPC Address',
    method: 'GET',
    path: '/npc/address',
    group: 'Legacy Compatibility',
    description: 'Legacy NPC extension route outside the v1 migration scope.',
    tags: ['legacy', 'wallet'],
  },
  {
    name: 'NPC Username',
    method: 'POST',
    path: '/npc/username',
    group: 'Legacy Compatibility',
    description: 'Legacy NPC username purchase route outside the v1 migration scope.',
    tags: ['legacy', 'mutation', 'financial'],
    body: json({ username: '{{npcUsername}}', confirm: false }),
  },
];

const proposedRequests: RequestDefinition[] = [
  {
    name: 'V1 Event Stream (Proposed)',
    method: 'GET',
    path: '/v1/events',
    group: 'Proposed Resources',
    description: 'Target SSE invalidation stream. This resource is not implemented yet.',
    tags: ['proposed', 'stream'],
  },
  {
    name: 'OpenAPI Description (Proposed)',
    method: 'GET',
    path: '/v1/openapi.json',
    group: 'Proposed Resources',
    description: 'Target generated OpenAPI document. This resource is not implemented yet.',
    tags: ['proposed', 'safe'],
  },
];

const description = (await Bun.file(interfacePath).json()) as InterfaceDescription;
const routeByKey = new Map(description.routes.map((route) => [routeKey(route), route]));

for (const request of implementedRequests) {
  if (!routeByKey.has(routeKey(request))) {
    throw new Error(`Bruno request has no implemented contract route: ${routeKey(request)}`);
  }
}

for (const route of description.routes) {
  if (!implementedRequests.some((request) => routeKey(request) === routeKey(route))) {
    throw new Error(`Implemented contract route is missing from Bruno: ${routeKey(route)}`);
  }
}

const outputs = new Map<string, string>();
outputs.set(
  'bruno.json',
  `{
  "version": "1",
  "name": "Cocod Network Interface v1",
  "type": "collection",
  "ignore": ["node_modules", ".git"]
}
`,
);
outputs.set(
  'collection.bru',
  `auth {
  mode: bearer
}

auth:bearer {
  token: {{clientCredential}}
}

headers {
  Accept: application/json
}

docs {
  # Cocod Network Interface v1

  Requests inherit the administrative Client Credential from the selected environment. The public
  health request overrides authentication. Mutation requests carry a disabled, random
  Idempotency-Key header that can be enabled when retry semantics are needed.
}
`,
);
outputs.set(
  'environments/local.bru',
  `vars {
  baseUrl: http://127.0.0.1:62626
  mintUrl: https://mint.example.com
  unit: sat
  amount: 100
  method: bolt11
  offset: 0
  limit: 20
  trustedOnly: true
  quoteDescription: Bruno protocol example
  onchainAddress: replace-with-address
  mintQuoteId: replace-with-mint-quote-id
  meltQuoteId: replace-with-melt-quote-id
  mintOperationId: replace-with-mint-operation-id
  meltOperationId: replace-with-melt-operation-id
  sendOperationId: replace-with-send-operation-id
  receiveOperationId: replace-with-receive-operation-id
  historyEntryId: replace-with-history-entry-id
  npcUsername: replace-with-username
}

vars:secret [
  clientCredential,
  walletPassphrase,
  bolt11Invoice,
  bolt12Offer,
  cashuToken,
  paymentRequest
]
`,
);
outputs.set('README.md', renderReadme(description));

const allRequests = [...implementedRequests, ...compatibilityRequests, ...proposedRequests];
for (const [group, sequence] of groupSequence) {
  outputs.set(
    `${group}/folder.bru`,
    `meta {
  name: ${group}
  seq: ${sequence}
}
`,
  );

  const requests = allRequests.filter((request) => request.group === group);
  requests.forEach((request, index) => {
    const contract = routeByKey.get(routeKey(request));
    const filename = `${String(index + 1).padStart(2, '0')}-${slug(request.name)}.bru`;
    outputs.set(`${group}/${filename}`, renderRequest(request, contract, index + 1));
  });
}

if (process.argv.includes('--check')) {
  let stale = false;
  for (const [path, expected] of outputs) {
    const file = Bun.file(new URL(path, collectionPath));
    const actual = (await file.exists()) ? await file.text() : null;
    if (actual !== expected) {
      console.error(`${relative(process.cwd(), file.name!)} is out of date`);
      stale = true;
    }
  }
  for await (const path of new Bun.Glob('**/*').scan({
    cwd: collectionPath.pathname,
    onlyFiles: true,
  })) {
    if (!outputs.has(path)) {
      console.error(`${relative(process.cwd(), new URL(path, collectionPath).pathname)} is stale`);
      stale = true;
    }
  }
  if (stale) process.exit(1);
} else {
  for (const [path, contents] of outputs) {
    const file = new URL(path, collectionPath);
    await mkdir(dirname(file.pathname), { recursive: true });
    await Bun.write(file, contents);
  }
}

function routeKey(route: Pick<ContractRoute, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function renderRequest(
  request: RequestDefinition,
  contract: ContractRoute | undefined,
  sequence: number,
): string {
  const method = request.method.toLowerCase();
  const publicRequest = request.path === '/health';
  const query = request.query?.length
    ? `\nparams:query {\n${request.query
        .map(({ name, value, enabled = true }) => `  ${enabled ? '' : '~'}${name}: ${value}`)
        .join('\n')}\n}\n`
    : '';
  const body = request.body
    ? `\nbody:json {\n${indent(JSON.stringify(request.body, null, 2), 2)}\n}\n`
    : '';
  const headers = [
    ...(request.body ? ['Content-Type: application/json'] : []),
    ...(contract?.idempotencyKey === 'optional' ? ['~Idempotency-Key: {{$guid}}'] : []),
  ];
  const headerBlock = headers.length
    ? `\nheaders {\n${headers.map((line) => `  ${line}`).join('\n')}\n}\n`
    : '';
  const capture = request.capture ? `\nscript:post-response {\n  ${request.capture}\n}\n` : '';
  const success = contract?.successStatuses.length
    ? contract.successStatuses.join(', ')
    : contract
      ? 'no success status; specified as not_found'
      : 'not part of the implemented v1 contract';
  const cache = contract?.responseCacheControl
    ? ` Response cache policy: ${contract.responseCacheControl}.`
    : '';
  const source = contract
    ? 'Implemented v1 contract.'
    : request.tags.includes('proposed')
      ? 'Accepted target surface; currently proposed.'
      : 'Authenticated legacy compatibility surface.';

  return `meta {
  name: ${request.name}
  type: http
  seq: ${sequence}
  tags: [
${request.tags.map((tag) => `    ${tag}`).join('\n')}
  ]
}

${method} {
  url: {{baseUrl}}${renderPath(request.path)}
  body: ${request.body ? 'json' : 'none'}
  auth: ${publicRequest ? 'none' : 'inherit'}
}
${query}${headerBlock}${body}${capture}
docs {
  ${request.description}

  ${source} Expected success status: ${success}.${cache}
}
`;
}

function renderPath(path: string): string {
  return path
    .replace('{historyEntryId}', '{{historyEntryId}}')
    .replace('/quotes/mint/{quoteId}', '/quotes/mint/{{mintQuoteId}}')
    .replace('/quotes/melt/{quoteId}', '/quotes/melt/{{meltQuoteId}}')
    .replace('/operations/mint/{operationId}', '/operations/mint/{{mintOperationId}}')
    .replace('/operations/melt/{operationId}', '/operations/melt/{{meltOperationId}}')
    .replace('/operations/send/{operationId}', '/operations/send/{{sendOperationId}}')
    .replace('/operations/receive/{operationId}', '/operations/receive/{{receiveOperationId}}');
}

function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function renderReadme(api: InterfaceDescription): string {
  return `# Cocod Network Interface v1 — Bruno collection

This collection translates the protocol contract in
[\`network-interface-v1.md\`](../docs/network-interface-v1.md) into runnable requests. Its
implemented-route coverage is checked against
[\`lifecycle-api-v1.json\`](../docs/lifecycle-api-v1.json) (cocod ${api.version}, interface
version ${api.interfaceVersion}). It also separates the remaining legacy compatibility routes and
the accepted-but-proposed v1 resources.

## Setup

1. Open this directory as a collection in Bruno.
2. Select the \`local\` environment.
3. Set the secret \`clientCredential\` from the host-local credential file
   (normally \`~/.cocod/credentials/current/client\`).
4. Replace the example \`mintUrl\` and other ordinary environment values.
5. Set secret request inputs only when needed: \`walletPassphrase\`, \`bolt11Invoice\`,
   \`bolt12Offer\`, \`cashuToken\`, and \`paymentRequest\`.

The collection stores no secret values in Git. Create requests capture Quote and Operation IDs as
ephemeral runtime variables, so the corresponding inspect and command requests can be run next.

## Safety

Do not run the entire collection blindly. Requests tagged \`financial\`, \`mutation\`, \`sensitive\`,
or \`shutdown\` can reserve proofs, move funds, reveal recovery material, change lifecycle state,
or stop cocod. Operation preparation is durable and is not a dry run.

The random \`Idempotency-Key\` header on supported mutations is disabled by default. Enable it for
a deliberate retry; keep the same concrete key when retrying the same request. Idempotency records
last only for the current Cocod Process.

The \`Proposed Resources\` folder documents the accepted target paths but they are not callable in
the current implementation. The unsupported Mint and Receive result requests intentionally
demonstrate the specified \`not_found\` behavior.

## Regeneration

From \`packages/cocod\`:

\`\`\`sh
bun run generate:bruno
bun run check:bruno
\`\`\`
`;
}
