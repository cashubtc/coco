import type { Logger } from '../logging/Logger.ts';
import type { SubscriptionManager } from '../infra/SubscriptionManager.ts';

export class SubscriptionApi {
  constructor(_subs: SubscriptionManager, _logger?: Logger) {}
}
