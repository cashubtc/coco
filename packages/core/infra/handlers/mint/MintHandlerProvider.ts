import type {
  BuiltInMintMethod,
  GenericMintMethod,
  MintMethod,
  MintMethodHandler,
  MintMethodHandlerRegistry,
  ValidatedGenericMintMethod,
} from '../../../operations/mint/MintMethodHandler';

const BUILT_IN_MINT_METHODS = new Set<string>(['bolt11', 'onchain', 'bolt12']);

export function isBuiltInMintMethod(method: string): method is BuiltInMintMethod {
  return BUILT_IN_MINT_METHODS.has(method);
}

export function assertGenericMintMethod<M extends string>(
  method: M,
): asserts method is GenericMintMethod<M> {
  if (isBuiltInMintMethod(method)) {
    throw new Error(`Built-in mint method ${method} must use its built-in handler path`);
  }
}

export function toGenericMintMethod(method: string): ValidatedGenericMintMethod {
  assertGenericMintMethod(method);
  return method as ValidatedGenericMintMethod;
}

/**
 * Runtime registry for mint method handlers.
 */
export class MintHandlerProvider {
  private registry: Partial<Record<MintMethod, MintMethodHandler<any>>> = {};

  constructor(initialHandlers?: Partial<MintMethodHandlerRegistry>) {
    if (initialHandlers) {
      this.registerMany(initialHandlers);
    }
  }

  register<M extends MintMethod>(method: M, handler: MintMethodHandler<M>): void {
    this.set(method, handler);
  }

  registerMany(handlers: Partial<MintMethodHandlerRegistry>): void {
    for (const method of Object.keys(handlers) as MintMethod[]) {
      const handler = handlers[method];
      if (handler) {
        this.set(method, handler as MintMethodHandler<typeof method>);
      }
    }
  }

  get<M extends MintMethod>(method: M): MintMethodHandler<M> {
    const handler = this.registry[method];
    if (!handler) {
      throw new Error(`No mint handler registered for method ${method}`);
    }
    return handler as MintMethodHandler<M>;
  }

  getAll(): MintMethodHandlerRegistry {
    return this.registry as MintMethodHandlerRegistry;
  }

  private set<M extends MintMethod>(method: M, handler: MintMethodHandler<M>): void {
    (this.registry as Partial<Record<M, MintMethodHandler<M>>>)[method] = handler;
  }
}
