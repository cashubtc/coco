/**
 * Real-process coverage of the wallet fault palette: transport faults (dropped requests and
 * responses, delays, Wallet-to-mint outages, WebSocket disconnects) and process faults (Wallet
 * crashes and mint restarts), with automatic and explicit recovery kept apart.
 *
 * Each scenario starts its own pinned mint containers, Fault Lab gateways, transport link and
 * Wallet processes. Run with `bun run test:fault-simulation` from the repository root.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MINT_MNEMONICS, MintContainer } from './environment.ts';
import { runScenario, type ScenarioRun } from './runner.ts';
import { scenarios } from './scenarios.ts';
import { generateWorkload } from './workload.ts';
import { FaultLabGateway, preparePinnedGateway } from './faultLabGateway.ts';
import {
  PROBE_HEADERS,
  TransportLink,
  canonicalMintUrl,
  prepareTransportLink,
  walletTag,
} from './transportLink.ts';

const scenarioTimeoutMs = 180_000;
const faultScenarioTimeoutMs = 300_000;
const cacheRoot = fileURLToPath(new URL('../../../../.cache/fault-simulation', import.meta.url));

type Outcome = number | 'connection_failed';
const settle = (request: Promise<Response>): Promise<Outcome> =>
  request.then(
    (response) => response.status,
    () => 'connection_failed' as const,
  );

function openWebSocket(url: string, options: Record<string, unknown>) {
  const socket = new WebSocket(url, options as never);
  const opened = new Promise<boolean>((resolve) => {
    socket.addEventListener('open', () => resolve(true));
    socket.addEventListener('error', () => resolve(false));
    socket.addEventListener('close', () => resolve(false));
  });
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener('close', (event) => resolve(event.code)),
  );
  return { socket, opened, closed };
}

describe('transport link in front of a real mint', () => {
  it(
    'carries Wallet HTTP through the Fault Lab gateway and WebSockets to the mint, under control',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'coco-link-'));
      const mint = await MintContainer.start(
        `coco-faultsim-link-${process.pid}`,
        MINT_MNEMONICS[0]!,
      );
      let gateway: FaultLabGateway | undefined;
      let link: TransportLink | undefined;
      try {
        gateway = await FaultLabGateway.start({
          bundlePath: await preparePinnedGateway(cacheRoot),
          downstream: mint.directUrl,
          logPath: join(dir, 'gateway.log'),
        });
        link = await TransportLink.start({
          bundlePath: await prepareTransportLink(cacheRoot),
          mints: [{ name: 'mint-a', gateway: gateway.url, direct: mint.directUrl }],
          wallets: ['alice', 'bob'],
          logPath: join(dir, 'link.log'),
        });
        const mintUrl = canonicalMintUrl('mint-a');
        const wsUrl = `${mintUrl.replace('http', 'ws')}/v1/ws`;
        const via = (wallet: string) => ({ proxy: link!.proxyFor(wallet) });

        // Negative controls: the bare gateway cannot carry a WebSocket, and the canonical mint URL
        // is unreachable without the link.
        const bare = openWebSocket(`${gateway.url.replace('http', 'ws')}/v1/ws`, {});
        expect(await bare.opened).toBe(false);
        expect(await settle(fetch(`${mintUrl}/v1/info`))).toBe('connection_failed');

        // HTTP reaches the mint through the gateway.
        expect(await settle(fetch(`${mintUrl}/v1/info`, via('alice')))).toBe(200);
        expect((await gateway.evidence()).requests).toContainEqual(
          expect.objectContaining({ method: 'GET', path: '/v1/info' }),
        );

        // A gateway rule scoped to one Wallet's tag only affects that Wallet's traffic. (A POST:
        // Bun's fetch retries a GET once when a reused connection closes.) The mint's answer, a
        // protocol error for this empty request, is delivered intact.
        const checkstate = (wallet: string) =>
          settle(
            fetch(`${mintUrl}/v1/checkstate`, {
              ...via(wallet),
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ Ys: [] }),
            }),
          );
        const ruleId = await gateway.addRule({
          phase: 'before_forward',
          action: 'drop',
          count: 1,
          match: { method: 'POST', path: '/v1/checkstate', operationId: walletTag('alice') },
        });
        expect(await checkstate('bob')).toBe(400);
        expect(await checkstate('alice')).toBe('connection_failed');
        expect(await checkstate('alice')).toBe(400);
        expect((await gateway.evidence()).rules.find((rule) => rule.id === ruleId)?.applied).toBe(
          1,
        );

        // A WebSocket tunnelled through the link reaches the mint and carries NUT-17 traffic.
        const ws = openWebSocket(wsUrl, via('alice'));
        expect(await ws.opened).toBe(true);
        const reply = new Promise<string>((resolve) =>
          ws.socket.addEventListener('message', (event) => resolve(String(event.data))),
        );
        ws.socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'subscribe',
            params: { kind: 'proof_state', subId: 'probe', filters: [] },
            id: 1,
          }),
        );
        expect(JSON.parse(await reply)).toMatchObject({ jsonrpc: '2.0', id: 1 });
        let evidence = await link.evidence();
        expect(evidence.wallets.alice!.mints['mint-a']).toMatchObject({
          webSocketsOpen: 1,
          webSocketUpgrades: 1,
        });
        expect(evidence.wallets.alice!.mints['mint-a']!.webSocketBytesFromMint).toBeGreaterThan(0);

        // Dropping WebSockets closes the connection abruptly, without a close frame.
        expect(await link.dropWebSockets('alice', 'mint-a')).toBe(1);
        expect(await ws.closed).toBe(1006);

        // An outage refuses the Wallet's connections until it ends; other Wallets are unaffected.
        await link.disconnect({ wallets: ['alice'], mints: ['mint-a'] });
        expect(await settle(fetch(`${mintUrl}/v1/info`, via('alice')))).toBe('connection_failed');
        expect(await openWebSocket(wsUrl, via('alice')).opened).toBe(false);
        expect(await settle(fetch(`${mintUrl}/v1/info`, via('bob')))).toBe(200);
        evidence = await link.evidence();
        expect(evidence.wallets.alice!.mints['mint-a']!.offline).toBe(true);
        expect(evidence.wallets.alice!.mints['mint-a']!.refusedConnections).toBeGreaterThanOrEqual(
          2,
        );
        await link.reconnect();
        expect(await settle(fetch(`${mintUrl}/v1/info`, via('alice')))).toBe(200);
        const probe = openWebSocket(wsUrl, { ...via('alice'), headers: PROBE_HEADERS });
        expect(await probe.opened).toBe(true);
        probe.socket.close();
        evidence = await link.evidence();
        expect(evidence.wallets.alice!.mints['mint-a']).toMatchObject({
          offline: false,
          webSocketsClosedByFault: 1,
          probeWebSockets: 1,
        });
        expect(evidence.wallets.alice!.unrouted).toBe(0);
      } finally {
        await link?.stop();
        await gateway?.stop();
        mint.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    scenarioTimeoutMs,
  );
});

/** Outcome fields compared as one object so a mismatch also prints the reason and findings. */
function outcomeOf(run: ScenarioRun) {
  return {
    outcome: run.outcome,
    expectationMet: run.expectationMet,
    reason: run.reason,
    findings: run.verdict?.findings.map((finding) => `${finding.code}: ${finding.message}`),
    checkpoints: run.checkpoints.map((checkpoint) => checkpoint.status),
    tracePath: run.tracePath,
  };
}

function expectSecretFreeTrace(run: ScenarioRun) {
  const trace = readFileSync(run.tracePath, 'utf8');
  expect(run.secretsChecked).toBeGreaterThan(0);
  for (const marker of ['cashuA', 'cashuB', '"secret"', 'seed":"']) {
    expect(trace).not.toContain(marker);
  }
}

/** Different Wallets' steps run concurrently, so compare their records in plan order. */
const byStep = <T extends { step?: number }>(records: T[]) =>
  [...records].sort((a, b) => (a.step ?? 0) - (b.step ?? 0));

const commandsOf = (run: ScenarioRun, kind: string) =>
  run.commands.filter((command) => command.kind === kind);

describe('HTTP exchange faults', () => {
  it(
    'a Receive whose swap request or successful response is lost recovers inline',
    async () => {
      const run = await runScenario(scenarios.lostReceiveExchanges);

      expect(outcomeOf(run)).toMatchObject({ outcome: 'pass', expectationMet: true });
      expect(byStep(run.faultsFired)).toEqual([
        expect.objectContaining({
          kind: 'dropRequest',
          wallet: 'bob',
          phase: 'before_forward',
          action: 'drop',
          path: '/v1/swap',
          applied: 1,
        }),
        expect.objectContaining({
          kind: 'dropResponse',
          wallet: 'carol',
          phase: 'after_downstream_response',
          action: 'drop',
          applied: 1,
        }),
      ]);
      // The dropped request never reached the mint, so Coco submitted the same swap again; the
      // dropped response followed a committed swap, so Coco restored its outputs instead.
      expect(byStep(run.exchanges)).toEqual([
        expect.objectContaining({ wallet: 'bob', fault: 'dropRequest', swapAttempts: 2 }),
        expect.objectContaining({ wallet: 'carol', fault: 'dropResponse', restoreRequests: 1 }),
      ]);
      expect(byStep(commandsOf(run, 'receive')).map((command) => command.exposure)).toEqual([
        'dropRequest',
        'dropResponse',
      ]);
      expect(run.verdict?.ledger).toMatchObject({ outstanding: 0, unexplained: 0, stranded: 0 });
      expect(run.recoveries).toEqual([]);
      expectSecretFreeTrace(run);
    },
    faultScenarioTimeoutMs,
  );

  for (const [mode, plan] of [
    ['explicit', scenarios.lostSendExchangesExplicit],
    ['automatic', scenarios.lostSendExchangesAutomatic],
  ] as const) {
    it(
      `${mode} recovery: Sends interrupted before and after the mint's effect reach pending`,
      async () => {
        const run = await runScenario(plan);

        expect(outcomeOf(run)).toMatchObject({ outcome: 'pass', expectationMet: true });
        // Pre-mint request loss left the Send's inputs unspent; post-success response loss left
        // them spent at the mint. Both Sends were interrupted while executing.
        expect(byStep(run.exchanges)).toEqual([
          expect.objectContaining({
            wallet: 'alice',
            fault: 'dropRequest',
            result: 'interrupted',
            mintAcceptedRequest: false,
            persistedOperationState: 'executing',
          }),
          expect.objectContaining({
            wallet: 'bob',
            fault: 'dropResponse',
            result: 'interrupted',
            mintAcceptedRequest: true,
            persistedOperationState: 'executing',
          }),
        ]);
        if (mode === 'explicit') {
          // Explicit recovery calls are inspected by their effect, not their return.
          // Recoveries of different Wallets run concurrently; compare them in Wallet order.
          const recoveries = [...run.recoveries].sort((a, b) => a.wallet.localeCompare(b.wallet));
          expect(recoveries).toEqual([
            expect.objectContaining({
              wallet: 'alice',
              transitions: [expect.objectContaining({ before: 'executing', after: 'pending' })],
            }),
            expect.objectContaining({
              wallet: 'bob',
              transitions: [expect.objectContaining({ before: 'executing', after: 'pending' })],
            }),
          ]);
        } else {
          // Recoveries of different Wallets run concurrently; compare them in Wallet order.
          const recoveries = [...run.recoveries].sort((a, b) => a.wallet.localeCompare(b.wallet));
          expect(recoveries).toEqual([]);
          expect(commandsOf(run, 'restart')).toHaveLength(2);
        }
        // The recovered tokens were then delivered and received once.
        expect(commandsOf(run, 'receive').map((command) => command.result)).toEqual([
          'completed',
          'completed',
        ]);
        expect(run.verdict?.ledger).toMatchObject({ outstanding: 0, unexplained: 0, stranded: 0 });
        expectSecretFreeTrace(run);
      },
      faultScenarioTimeoutMs,
    );
  }

  it(
    'negative control: an interrupted Send left without recovery fails after healing',
    async () => {
      const run = await runScenario(scenarios.lostSendResponseUnrecovered);

      // A detected wallet failure is this control's expected result, not a passing scenario.
      expect(outcomeOf(run)).toMatchObject({ outcome: 'wallet_failure', expectationMet: true });
      expect(run.checkpoints.at(-1)).toMatchObject({ expectedOutcomesMet: false });
      const codes = run.verdict?.findings.map((finding) => finding.code);
      expect(codes).toContain('outcome_unmet');
      expect(run.recoveries).toEqual([]);
    },
    faultScenarioTimeoutMs,
  );
});

describe('connection faults', () => {
  it(
    'Wallet-to-mint outages: interrupted work recovers and pending Sends finalize after reconnect',
    async () => {
      const run = await runScenario(scenarios.walletOutages);

      expect(outcomeOf(run)).toMatchObject({ outcome: 'pass', expectationMet: true });
      const outages = run.faultsFired.filter((fault) => fault.kind === 'disconnect');
      expect(outages.map(({ wallet, mint }) => ({ wallet, mint }))).toEqual([
        { wallet: 'alice', mint: 'mint-b' },
        { wallet: 'bob', mint: 'mint-a' },
      ]);
      for (const outage of outages) expect(outage.applied).toBeGreaterThan(0);
      // The Receive attempted while offline had no remote effect and stayed executing.
      expect(byStep(run.exchanges)).toEqual([
        expect.objectContaining({
          wallet: 'bob',
          fault: 'outage',
          result: 'interrupted',
          mintAcceptedRequest: false,
          persistedOperationState: 'executing',
        }),
      ]);
      expect(run.verdict?.ledger).toMatchObject({ outstanding: 0, unexplained: 0, stranded: 0 });
      expectSecretFreeTrace(run);
    },
    faultScenarioTimeoutMs,
  );

  it(
    'WebSocket disconnects and delayed responses: Coco falls back to polling and stays accounted',
    async () => {
      const run = await runScenario(scenarios.webSocketAndDelays);

      expect(outcomeOf(run)).toMatchObject({ outcome: 'pass', expectationMet: true });
      expect(run.faultsFired).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'dropWebSockets',
            wallet: 'alice',
            mint: 'mint-a',
            applied: 1,
          }),
          expect.objectContaining({ kind: 'delayResponses', wallet: 'bob', action: 'delay' }),
        ]),
      );
      // Explicit networking repair opened a new WebSocket through the link.
      const alice = run.transport.find(
        (entry) => entry.wallet === 'alice' && entry.mint === 'mint-a',
      );
      expect(alice!.webSocketUpgrades).toBeGreaterThanOrEqual(2);
      expect(alice!.webSocketsClosedByFault).toBe(1);
      expect(run.verdict?.ledger).toMatchObject({ unexplained: 0, stranded: 0 });
      expectSecretFreeTrace(run);
    },
    faultScenarioTimeoutMs,
  );
});

describe('process faults', () => {
  it(
    'abrupt Wallet crashes during a Send and while idle recover on restart',
    async () => {
      const run = await runScenario(scenarios.walletCrashes);

      expect(outcomeOf(run)).toMatchObject({ outcome: 'pass', expectationMet: true });
      expect(run.crashes).toEqual([
        expect.objectContaining({
          wallet: 'alice',
          signal: 'SIGKILL',
          trigger: 'fault_fired',
          mintAcceptedRequest: true,
          persistedOperationState: 'executing',
        }),
        expect.objectContaining({ wallet: 'carol', signal: 'SIGKILL', trigger: 'step' }),
      ]);
      expect(run.verdict?.ledger).toMatchObject({ unexplained: 0, stranded: 0 });
      expectSecretFreeTrace(run);
    },
    faultScenarioTimeoutMs,
  );

  it(
    'a mint restart keeps its committed state and Wallets continue afterwards',
    async () => {
      const run = await runScenario(scenarios.mintRestart);

      expect(outcomeOf(run)).toMatchObject({ outcome: 'pass', expectationMet: true });
      expect(run.mintRestarts).toEqual([
        expect.objectContaining({
          mint: 'mint-a',
          keysetsRetained: true,
          proofStatesRetained: true,
        }),
      ]);
      expect(run.mintRestarts[0]!.spentProofsChecked).toBeGreaterThan(0);
      expect(run.mintRestarts[0]!.startedAtAfter).not.toBe(run.mintRestarts[0]!.startedAtBefore);
      // The duplicate delivery after the restart is rejected: the spend survived the restart.
      // Carol's and Bob's Receives after the restart run concurrently; compare in plan order.
      expect(byStep(commandsOf(run, 'receive')).map((command) => command.result)).toEqual([
        'completed',
        'completed',
        'rejected',
        'completed',
      ]);
      expect(run.verdict?.ledger).toMatchObject({ unexplained: 0, stranded: 0 });
      expectSecretFreeTrace(run);
    },
    faultScenarioTimeoutMs,
  );

  it(
    'negative control: a mint that does not come back is an infrastructure failure',
    async () => {
      const run = await runScenario(scenarios.mintDoesNotRestartControl);

      expect(outcomeOf(run)).toMatchObject({
        outcome: 'infrastructure_failure',
        expectationMet: true,
      });
      expect(run.reason).toContain('InfrastructureFailure');
    },
    faultScenarioTimeoutMs,
  );
});

const faultSeeds = (process.env.COCO_FAULT_SIM_FAULT_SEEDS ?? '5,18')
  .split(',')
  .map((seed) => Number(seed.trim()));

describe('generated workloads with fault interactions', () => {
  for (const seed of faultSeeds) {
    for (const recoveryMode of ['automatic', 'explicit'] as const) {
      it(`scenario seed ${seed}, ${recoveryMode} recovery: every fault fires and value stays accounted`, async () => {
        const plan = generateWorkload({
          seed,
          wallets: ['alice', 'bob', 'carol'],
          mints: ['mint-a', 'mint-b'],
          commands: 24,
          initialFunding: 128,
          maxAmount: 32,
          checkpointEvery: 8,
          faults: true,
          recoveryMode,
        });
        const run = await runScenario(plan);

        expect(outcomeOf(run)).toMatchObject({ outcome: 'pass', expectationMet: true });
        expect(run.checkpoints.every((checkpoint) => checkpoint.status === 'pass')).toBe(true);
        const installed = plan.steps.filter((step) =>
          ['dropRequest', 'dropResponse', 'withholdResponse', 'delayResponses'].includes(step.kind),
        ).length;
        const linkFaults = plan.steps.filter((step) =>
          ['disconnect', 'dropWebSockets'].includes(step.kind),
        ).length;
        expect(run.faultsFired).toHaveLength(installed + linkFaults);
        expect(run.mintRestarts).toHaveLength(
          plan.steps.filter((step) => step.kind === 'restartMint').length,
        );
        if (recoveryMode === 'automatic') expect(run.recoveries).toEqual([]);
        expectSecretFreeTrace(run);
      }, 900_000);
    }
  }
});
