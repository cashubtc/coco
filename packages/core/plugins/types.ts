import type { SubscriptionManager } from '../infra/SubscriptionManager.ts';
import type { EventBus } from '../events/EventBus.ts';
import type { CoreEvents } from '../events/types.ts';
import type { Logger } from '../logging/Logger.ts';
import type {
  CounterService,
  HistoryService,
  KeyRingService,
  MeltQuoteService,
  MintQuoteService,
  MintService,
  ProofService,
  SeedService,
  TransactionService,
  WalletRestoreService,
  WalletService,
} from '../services';

export type ServiceKey =
  | 'mintService'
  | 'walletService'
  | 'proofService'
  | 'keyRingService'
  | 'seedService'
  | 'walletRestoreService'
  | 'counterService'
  | 'mintQuoteService'
  | 'meltQuoteService'
  | 'historyService'
  | 'transactionService'
  | 'subscriptions'
  | 'eventBus'
  | 'logger';

export interface ServiceMap {
  mintService: MintService;
  walletService: WalletService;
  proofService: ProofService;
  keyRingService: KeyRingService;
  seedService: SeedService;
  walletRestoreService: WalletRestoreService;
  counterService: CounterService;
  mintQuoteService: MintQuoteService;
  meltQuoteService: MeltQuoteService;
  historyService: HistoryService;
  transactionService: TransactionService;
  subscriptions: SubscriptionManager;
  eventBus: EventBus<CoreEvents>;
  logger: Logger;
}

export interface PluginContext<Req extends readonly ServiceKey[] = readonly ServiceKey[]> {
  services: Pick<ServiceMap, Req[number]>;
}

export type CleanupFn = () => void | Promise<void>;
export type Cleanup = void | CleanupFn | Promise<void | CleanupFn>;

export interface Plugin<Req extends readonly ServiceKey[] = readonly ServiceKey[]> {
  name: string;
  required: Req;
  optional?: readonly ServiceKey[];
  onInit?(ctx: PluginContext<Req>): Cleanup;
  onReady?(ctx: PluginContext<Req>): Cleanup;
  onDispose?(): void | Promise<void>;
}
