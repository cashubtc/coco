import type { SubscriptionManager } from '../infra/SubscriptionManager.ts';
import type { EventBus } from '../events/EventBus.ts';
import type { CoreEvents } from '../events/types.ts';
import type { Logger } from '../logging/Logger.ts';
import type {
  CounterService,
  HistoryService,
  MeltQuoteService,
  MintQuoteService,
  MintService,
  ProofService,
  SeedService,
  WalletRestoreService,
  WalletService,
} from '../services';

export type ServiceKey =
  | 'mintService'
  | 'walletService'
  | 'proofService'
  | 'seedService'
  | 'walletRestoreService'
  | 'counterService'
  | 'mintQuoteService'
  | 'meltQuoteService'
  | 'historyService'
  | 'subscriptions'
  | 'eventBus'
  | 'logger';

export interface ServiceMap {
  mintService: MintService;
  walletService: WalletService;
  proofService: ProofService;
  seedService: SeedService;
  walletRestoreService: WalletRestoreService;
  counterService: CounterService;
  mintQuoteService: MintQuoteService;
  meltQuoteService: MeltQuoteService;
  historyService: HistoryService;
  subscriptions: SubscriptionManager;
  eventBus: EventBus<CoreEvents>;
  logger: Logger;
}

export interface PluginContext<Req extends readonly ServiceKey[] = readonly ServiceKey[]> {
  services: Pick<ServiceMap, Req[number]>;
}

export interface Plugin<Req extends readonly ServiceKey[] = readonly ServiceKey[]> {
  name: string;
  required: Req;
  optional?: readonly ServiceKey[];
  onInit?(
    ctx: PluginContext<Req>,
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
  onReady?(
    ctx: PluginContext<Req>,
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
  onDispose?(): void | Promise<void>;
}
