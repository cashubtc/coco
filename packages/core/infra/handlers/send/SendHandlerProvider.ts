import type {
  SendMethod,
  SendMethodHandler,
  SendMethodHandlerRegistry,
} from '../../../operations/send/SendMethodHandler';

/** Lookup for send method handlers fixed at construction. */
export class SendHandlerProvider {
  private readonly registry: Readonly<Partial<SendMethodHandlerRegistry>>;

  constructor(initialHandlers: Partial<SendMethodHandlerRegistry> = {}) {
    this.registry = Object.freeze({ ...initialHandlers });
  }

  get<M extends SendMethod>(method: M): SendMethodHandler<M> {
    const handler = this.registry[method];
    if (!handler) {
      throw new Error(`No send handler registered for method ${method}`);
    }
    return handler as SendMethodHandler<M>;
  }
}
