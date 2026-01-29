import type {
  SendMethod,
  SendMethodHandler,
  SendMethodHandlerRegistry,
} from '../../../operations/send/SendMethodHandler';

/**
 * Runtime registry for send method handlers.
 * Keeps wiring concerns out of the core send domain.
 */
export class SendHandlerProvider {
  private registry: Partial<SendMethodHandlerRegistry> = {};

  constructor(initialHandlers?: Partial<SendMethodHandlerRegistry>) {
    if (initialHandlers) {
      this.registerMany(initialHandlers);
    }
  }

  register<M extends SendMethod>(method: M, handler: SendMethodHandler<M>): void {
    this.registry[method] = handler;
  }

  registerMany(handlers: Partial<SendMethodHandlerRegistry>): void {
    for (const [method, handler] of Object.entries(handlers)) {
      if (handler) {
        this.registry[method as SendMethod] = handler;
      }
    }
  }

  get<M extends SendMethod>(method: M): SendMethodHandler<M> {
    const handler = this.registry[method];
    if (!handler) {
      throw new Error(`No send handler registered for method ${method}`);
    }
    return handler as SendMethodHandler<M>;
  }

  getAll(): SendMethodHandlerRegistry {
    return this.registry as SendMethodHandlerRegistry;
  }
}
