import { createInterface } from 'node:readline/promises';
import {
  createPrototypeState,
  reducePrototype,
  type PrototypeAction,
  type PrototypeState,
} from './model.ts';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

interface Shortcut {
  key: string;
  description: string;
  action?: PrototypeAction;
}

function shortcuts(state: PrototypeState): Shortcut[] {
  if (!state.attempt) {
    return [
      {
        key: 'e',
        description: 'explicit coordinate(operation-3)',
        action: { type: 'explicit_dispatch' },
      },
      {
        key: 'p',
        description: 'processor coordinate() tick',
        action: { type: 'processor_dispatch' },
      },
      { key: 'n', description: 'toggle NUT-29 capability', action: { type: 'toggle_capability' } },
    ];
  }

  switch (state.attempt.phase) {
    case 'submitted':
      return [
        { key: 's', description: 'mint returns full success', action: { type: 'success' } },
        { key: 'a', description: 'mint response is ambiguous', action: { type: 'ambiguous' } },
        {
          key: 'x',
          description: 'competing explicit caller',
          action: { type: 'competing_explicit' },
        },
      ];
    case 'ambiguous':
      return [
        { key: 'r', description: 'restart and recover', action: { type: 'restart' } },
        {
          key: 'x',
          description: 'explicit caller joins recovery',
          action: { type: 'competing_explicit' },
        },
      ];
    case 'recovering':
      return [
        { key: 'p', description: 'observe every quote PAID', action: { type: 'observe_all_paid' } },
        {
          key: 'i',
          description: 'observe every quote ISSUED',
          action: { type: 'observe_all_issued' },
        },
        {
          key: 'x',
          description: 'explicit caller joins recovery',
          action: { type: 'competing_explicit' },
        },
      ];
    case 'restoring':
      return [
        {
          key: 'f',
          description: 'recover full exact proof set',
          action: { type: 'recover_proofs' },
        },
      ];
    case 'finalized':
      return [];
  }
}

function render(state: PrototypeState): void {
  console.clear();
  console.log(`${BOLD}PROTOTYPE — Mint issuance coordination seam${RESET}`);
  console.log(
    `${DIM}schedule(operationId) + coordinate(operationId?): one internal owner of singles and batches${RESET}\n`,
  );

  console.log(`${BOLD}Coordination${RESET}`);
  console.log(
    `NUT-29: ${state.nut29Available ? `available (limit ${state.batchLimit})` : 'unavailable'}`,
  );
  console.log(`mint lock: ${state.mintLock}  transaction: ${state.transaction}`);
  console.log(`caller: ${state.caller}`);

  console.log(`\n${BOLD}Mint Operations${RESET}`);
  for (const operation of state.operations) {
    console.log(
      `${operation.id}  state=${operation.state}  scheduled=${operation.scheduled}` +
        `${operation.attemptId ? `  attempt=${operation.attemptId}` : ''}`,
    );
    console.log(`  ${DIM}${operation.outcome}${RESET}`);
  }

  console.log(`\n${BOLD}Internal Mint Issuance Attempt${RESET}`);
  console.log(state.attempt ? JSON.stringify(state.attempt, null, 2) : `${DIM}none${RESET}`);

  console.log(`\n${BOLD}Module trace${RESET}`);
  for (const message of state.trace.slice(-8)) console.log(`- ${message}`);

  console.log(`\n${BOLD}Actions${RESET}`);
  for (const shortcut of shortcuts(state)) {
    console.log(`[${BOLD}${shortcut.key}${RESET}] ${shortcut.description}`);
  }
  console.log(`[${BOLD}c${RESET}] reset  [${BOLD}q${RESET}] quit`);
}

const readline = createInterface({ input: process.stdin, output: process.stdout });
let state = createPrototypeState();

while (true) {
  render(state);
  const input = (await readline.question('\n> ')).trim().toLowerCase();
  if (input === 'q') break;
  if (input === 'c') {
    state = createPrototypeState();
    continue;
  }

  const selected = shortcuts(state).find((shortcut) => shortcut.key === input);
  if (selected?.action) state = reducePrototype(state, selected.action);
}

readline.close();
