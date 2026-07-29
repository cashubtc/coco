import { describe, expect, test } from "bun:test";

import { createRouteHandlers } from "./routes";
import { DaemonStateManager } from "./utils/state";

describe("routes", () => {
  test("/init validates invalid mnemonic", async () => {
    const stateManager = new DaemonStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/init"]!.POST!(
      new Request("http://localhost/init", {
        method: "POST",
        body: JSON.stringify({ mnemonic: "invalid mnemonic" }),
      }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid mnemonic");
  });

  test("/unlock requires passphrase", async () => {
    const stateManager = new DaemonStateManager();
    stateManager.setLocked("encrypted", "https://mint.example.com");
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/unlock"]!.POST!(
      new Request("http://localhost/unlock", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Passphrase required");
  });

  test("/x-cashu/parse requires request field", async () => {
    const stateManager = new DaemonStateManager();
    const fakeManager = {} as unknown as import("coco-cashu-core").Manager;
    stateManager.setUnlocked(fakeManager, "https://mint.example.com", new Uint8Array([1, 2, 3]));
    const routes = createRouteHandlers(stateManager);

    const response = await routes["/x-cashu/parse"]!.POST!(
      new Request("http://localhost/x-cashu/parse", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Request is required");
  });
});
