import type { Manager } from "coco-cashu-core";

export interface UninitializedState {
  status: "UNINITIALIZED";
}

export interface LockedState {
  status: "LOCKED";
  encryptedMnemonic: string;
  mintUrl: string;
}

export interface UnlockedState {
  status: "UNLOCKED";
  manager: Manager;
  mintUrl: string;
  seed: Uint8Array;
}

export interface ErrorState {
  status: "ERROR";
  message: string;
}

export type DaemonState = UninitializedState | LockedState | UnlockedState | ErrorState;

export type RouteHandler = (req: Request, state: DaemonState) => Promise<Response>;

export class DaemonStateManager {
  private state: DaemonState;

  constructor(initialState: DaemonState = { status: "UNINITIALIZED" }) {
    this.state = initialState;
  }

  getState(): DaemonState {
    return this.state;
  }

  isUnlocked(): this is { getState: () => UnlockedState } {
    return this.state.status === "UNLOCKED";
  }

  isLocked(): this is { getState: () => LockedState } {
    return this.state.status === "LOCKED";
  }

  isUninitialized(): boolean {
    return this.state.status === "UNINITIALIZED";
  }

  setLocked(encryptedMnemonic: string, mintUrl: string): void {
    this.state = { status: "LOCKED", encryptedMnemonic, mintUrl };
  }

  setUnlocked(manager: Manager, mintUrl: string, seed: Uint8Array): void {
    this.state = { status: "UNLOCKED", manager, mintUrl, seed };
  }

  setUninitialized(): void {
    this.state = { status: "UNINITIALIZED" };
  }

  setError(message: string): void {
    this.state = { status: "ERROR", message };
  }

  requireUnlocked(
    handler: (req: Request, state: UnlockedState) => Promise<Response>,
  ): RouteHandler {
    return async (req: Request, state: DaemonState) => {
      if (state.status !== "UNLOCKED") {
        if (state.status === "LOCKED") {
          return Response.json(
            {
              error: "Wallet is locked. Run 'cocod unlock <passphrase>' to decrypt.",
            },
            { status: 403 },
          );
        }
        if (state.status === "UNINITIALIZED") {
          return Response.json(
            {
              error: "Wallet not initialized. Run 'cocod init [mnemonic]' first.",
            },
            { status: 503 },
          );
        }
        return Response.json({ error: "Wallet error" }, { status: 500 });
      }
      return handler(req, state as UnlockedState);
    };
  }

  requireUninitialized(handler: (req: Request) => Promise<Response>): RouteHandler {
    return async (req: Request, state: DaemonState) => {
      if (state.status !== "UNINITIALIZED") {
        return Response.json(
          {
            error: "Wallet already initialized. Delete ~/.cocod/config.json to reset.",
          },
          { status: 409 },
        );
      }
      return handler(req);
    };
  }

  requireLocked(handler: (req: Request, state: LockedState) => Promise<Response>): RouteHandler {
    return async (req: Request, state: DaemonState) => {
      if (state.status !== "LOCKED") {
        if (state.status === "UNINITIALIZED") {
          return Response.json(
            {
              error: "Wallet not initialized. Run 'cocod init [mnemonic]' first.",
            },
            { status: 503 },
          );
        }
        if (state.status === "UNLOCKED") {
          return Response.json({ error: "Wallet is already unlocked" }, { status: 409 });
        }
        return Response.json({ error: "Wallet error" }, { status: 500 });
      }
      return handler(req, state as LockedState);
    };
  }
}
