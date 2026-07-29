import { describe, expect, test } from "bun:test";

import { DaemonStateManager } from "./state";

describe("DaemonStateManager", () => {
  test("transitions through states", () => {
    const stateManager = new DaemonStateManager();

    expect(stateManager.getState().status).toBe("UNINITIALIZED");

    stateManager.setLocked("encrypted", "https://mint.example.com");
    expect(stateManager.getState().status).toBe("LOCKED");

    const fakeManager = {} as unknown as import("coco-cashu-core").Manager;
    stateManager.setUnlocked(fakeManager, "https://mint.example.com", new Uint8Array([1, 2, 3]));
    expect(stateManager.getState().status).toBe("UNLOCKED");

    stateManager.setError("boom");
    expect(stateManager.getState().status).toBe("ERROR");
  });

  test("requireUnlocked returns 403 when locked", async () => {
    const stateManager = new DaemonStateManager();
    stateManager.setLocked("encrypted", "https://mint.example.com");

    const handler = stateManager.requireUnlocked(async () => {
      return Response.json({ output: "ok" });
    });

    const response = await handler(
      new Request("http://localhost/balance"),
      stateManager.getState(),
    );
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(403);
    expect(body.error).toContain("locked");
  });

  test("requireLocked returns 409 when already unlocked", async () => {
    const stateManager = new DaemonStateManager();
    const fakeManager = {} as unknown as import("coco-cashu-core").Manager;
    stateManager.setUnlocked(fakeManager, "https://mint.example.com", new Uint8Array([1]));

    const handler = stateManager.requireLocked(async () => {
      return Response.json({ output: "ok" });
    });

    const response = await handler(new Request("http://localhost/unlock"), stateManager.getState());
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(409);
    expect(body.error).toContain("already unlocked");
  });
});
