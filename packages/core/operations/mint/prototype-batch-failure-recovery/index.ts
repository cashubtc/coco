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
  switch (state.attempt.phase) {
    case 'submitted':
      return [
        { key: 'y', description: 'valid success', action: { type: 'valid_success' } },
        { key: 'a', description: 'ambiguous response', action: { type: 'ambiguous_response' } },
        { key: 's', description: 'state rejection', action: { type: 'state_rejection' } },
        {
          key: 'v',
          description: 'other validation rejection',
          action: { type: 'validation_rejection' },
        },
        {
          key: 'z',
          description: 'batch-size rejection',
          action: { type: 'batch_size_rejection' },
        },
        {
          key: 'e',
          description: 'endpoint incompatibility',
          action: { type: 'endpoint_rejection' },
        },
      ];
    case 'checking_quotes':
      return [
        { key: 'p', description: 'observe all PAID', action: { type: 'observe_all_paid' } },
        {
          key: 'i',
          description: 'observe all ISSUED',
          action: { type: 'observe_all_issued' },
        },
        { key: 'm', description: 'observe mixed states', action: { type: 'observe_mixed' } },
        {
          key: 'u',
          description: 'observe unpaid/expired mix',
          action: { type: 'observe_unpaid_and_expired' },
        },
        { key: 'x', description: 'unusable check', action: { type: 'check_unusable' } },
      ];
    case 'ready_to_resume':
      return [
        {
          key: 'r',
          description: 'resume exact attempt',
          action: { type: 'resume_same_attempt' },
        },
      ];
    case 'recovering_outputs':
      return [
        { key: 'f', description: 'recover full output set', action: { type: 'recover_full' } },
        { key: 'n', description: 'recover no outputs', action: { type: 'recover_none' } },
        { key: 'h', description: 'recover partial outputs', action: { type: 'recover_partial' } },
        { key: 'x', description: 'unusable recovery', action: { type: 'recovery_unusable' } },
      ];
    case 'rejected':
    case 'finalized':
    case 'critical_failure':
      return [];
  }
}

function render(state: PrototypeState): void {
  console.clear();
  console.log(`${BOLD}PROTOTYPE — Mint Batch failure recovery${RESET}`);
  console.log(`${DIM}Drive a transition, then inspect the complete model.${RESET}\n`);
  console.log(`${BOLD}Attempt${RESET}`);
  console.log(JSON.stringify(state.attempt, null, 2));
  console.log(`\n${BOLD}Members${RESET}`);
  for (const member of state.members) {
    console.log(
      `${member.id}  quote=${member.quoteState}  operation=${member.operationState}\n` +
        `  ${DIM}${member.outcome}${RESET}`,
    );
  }
  console.log(`\n${BOLD}Next dispatch${RESET}: ${state.nextDispatch}`);
  console.log(`\n${BOLD}History${RESET}`);
  for (const message of state.history.slice(-6)) console.log(`- ${message}`);

  const available = shortcuts(state);
  console.log(`\n${BOLD}Actions${RESET}`);
  for (const shortcut of available) {
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
