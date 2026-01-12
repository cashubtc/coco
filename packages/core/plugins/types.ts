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
  PaymentRequestService,
  ProofService,
  SeedService,
  TransactionService,
  WalletRestoreService,
  WalletService,
} from '../services';
import type { SendOperationService } from '../operations/send/SendOperationService';
import type { MeltOperationService } from '../operations/melt/MeltOperationService';

export type ServiceKey = keyof ServiceMap;

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
  sendOperationService: SendOperationService;
  meltOperationService: MeltOperationService;
  paymentRequestService: PaymentRequestService;
  subscriptions: SubscriptionManager;
  eventBus: EventBus<CoreEvents>;
  logger: Logger;
}

export interface PluginContext<Req extends readonly ServiceKey[] = readonly ServiceKey[]> {
  services: Pick<ServiceMap, Req[number]>;
  /**
   * Register an API extension accessible via manager.ext.<key>
   * @param key - Unique identifier for this extension
   * @param api - The API object to expose
   * @throws ExtensionRegistrationError if key is already registered
   */
  registerExtension<K extends string>(key: K, api: unknown): void;
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

/**
 * Base interface for plugin extensions.
 * Plugin authors should augment this interface via module augmentation:
 *
 * @example
 * declare module '@coco/core' {
 *   interface PluginExtensions {
 *     myPlugin: MyPluginApi;
 *   }
 * }
 */
export interface PluginExtensions {}

/**
 * Error thrown when a plugin attempts to register an extension key that is already registered.
 */
export class ExtensionRegistrationError extends Error {
  constructor(pluginName: string, key: string) {
    super(
      `Plugin "${pluginName}" attempted to register extension "${key}", but it is already registered`,
    );
    this.name = 'ExtensionRegistrationError';
  }
}
