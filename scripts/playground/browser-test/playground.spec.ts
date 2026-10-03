import { test, expect, type Page } from '@playwright/test';
async function edit(page: Page, source: string) {
  await page.evaluate((source) => {
    const app = (window as any).__playground;
    app.editor.setValue(source);
    app.editor.focus();
    const model = app.editor.getModel();
    app.editor.setPosition(model.getPositionAt(source.length));
  }, source);
}
async function run(page: Page, source: string) {
  await expect(page.getByRole('button', { name: /^Run / })).toBeEnabled();
  await edit(page, source);
  await page.getByRole('button', { name: /^Run / }).click();
  await expect(page.getByRole('status')).toContainText('Ready');
}
const result = (page: Page) => page.locator('.entry[data-level="result"] pre').last();
const diagnostics = (page: Page) =>
  page.evaluate(() => {
    const app = (window as any).__playground;
    return app.monaco.editor
      .getModelMarkers({ resource: app.editor.getModel().uri })
      .map((marker: any) => marker.message)
      .join('\n');
  });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('Ready');
  await expect(page.locator('.entry')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
});
test('real public API state, persistent closures, source imports and fresh state after reset', async ({
  page,
}) => {
  await run(
    page,
    `const pair = await coco.keyring.generateKeyPair(); assert.equal((await coco.keyring.getAllKeyPairs()).length, 1); pair.publicKeyHex;`,
  );
  const first = await result(page).textContent();
  expect(first).toMatch(/^[0-9a-f]{66}$/);
  await run(
    page,
    `assert.ok(await coco.keyring.getKeyPair(pair.publicKeyHex)); let count: number = 1; const next = () => ++count; next();`,
  );
  await expect(result(page)).toHaveText('2');
  await run(page, `count = 7; next();`);
  await expect(result(page)).toHaveText('8');
  await run(
    page,
    `import { Amount as ImportedAmount } from '@cashu/coco-core'; assert.equal(ImportedAmount, core.Amount); assert.equal((await import('@cashu/coco-core')).Manager, Manager); ImportedAmount.from(42).toNumber();`,
  );
  await expect(result(page)).toHaveText('42');
  await page.getByRole('button', { name: /^Reset state/ }).click();
  await expect(page.getByRole('status')).toHaveText('Session 2 · Ready');
  await run(
    page,
    `[typeof pair, typeof count, (await coco.keyring.getAllKeyPairs()).length, (await coco.wallet.balances.total()).total.toNumber()]`,
  );
  await expect(result(page)).toHaveText('[\n  "undefined",\n  "undefined",\n  0,\n  0\n]');
  await run(page, `(await coco.keyring.generateKeyPair()).publicKeyHex`);
  expect(await result(page).textContent()).not.toBe(first);
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Session 1 · Ready');
  await run(page, `(await coco.keyring.getAllKeyPairs()).length`);
  await expect(result(page)).toHaveText('0');
});
test('logs, assertions, syntax errors and runtime errors remain recoverable', async ({ page }) => {
  await run(page, `console.log('visible log', { amount: 2n }); assert.equal(1, 2);`);
  await expect(page.locator('.entry[data-level="log"]')).toContainText('visible log');
  await expect(page.locator('.entry[data-level="error"]').last()).toContainText('AssertionError');
  await run(page, `const broken = ;`);
  await expect(page.locator('.entry[data-level="error"]').last()).toContainText('SyntaxError');
  await run(page, `const broken = 3; let retained = 4; throw new Error('kept');`);
  await expect(page.locator('.entry[data-level="error"]').last()).toContainText('kept');
  await run(page, `retained++; broken + retained`);
  await expect(result(page)).toHaveText('8');
  await run(page, `await import('node:fs')`);
  await expect(page.locator('.entry[data-level="error"]').last()).toContainText('not bundled');
  await run(page, `21 * 2`);
  await expect(result(page)).toHaveText('42');
});
test('timer exceptions and promise rejections preserve a usable session', async ({ page }) => {
  await run(
    page,
    `
    const retained = 42;
    setTimeout(() => { throw new Error('timer failure'); }, 10);
    void Promise.reject(new Error('background rejection'));
    retained;
  `,
  );
  await expect(page.locator('#output')).toContainText('timer failure');
  await expect(page.locator('#output')).toContainText('background rejection');
  await run(page, 'retained');
  await expect(result(page)).toHaveText('42');
  await expect(page.getByRole('status')).toHaveText('Session 1 · Ready');
});
test('declaration validation precedes mutations and imports work anywhere in the buffer', async ({
  page,
}) => {
  await run(page, 'let retained = 0;');
  await run(page, 'retained++; const missing;');
  await expect(page.locator('.entry[data-level="error"]').last()).toContainText('SyntaxError');
  await run(page, 'retained');
  await expect(result(page)).toHaveText('0');
  await run(
    page,
    `
    const amount = ImportedAmount.from(42);
    import { Amount as ImportedAmount } from '@cashu/coco-core';
    amount.toNumber();
  `,
  );
  await expect(result(page)).toHaveText('42');
});
test('editor globals match worker APIs', async ({ page }) => {
  await edit(page, 'document.title;');
  await expect.poll(() => diagnostics(page)).toContain('document');
  await edit(page, 'const workerScope: WorkerGlobalScope = self; crypto.randomUUID(); fetch("/");');
  await expect.poll(() => diagnostics(page)).toBe('');
});
test('invalid imports and resource declarations preserve state and editor history', async ({
  page,
}) => {
  await run(page, 'let retained = 7;');
  for (const source of [
    `import { Missing as retained } from '@cashu/coco-core'; await coco.keyring.generateKeyPair();`,
    `import retained from '@cashu/coco-core'; await coco.keyring.generateKeyPair();`,
    `import {} from 'unsupported-package'; await coco.keyring.generateKeyPair();`,
    `await coco.keyring.generateKeyPair(); using resource = null;`,
    `await coco.keyring.generateKeyPair(); await using resource = null;`,
  ]) {
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await run(page, source);
    await expect(page.locator('.entry[data-level="error"]')).toHaveCount(1);
    await run(page, '[retained, (await coco.keyring.getAllKeyPairs()).length]');
    await expect(result(page)).toHaveText('[\n  7,\n  0\n]');
    await edit(page, 'const check: number = retained;');
    await expect.poll(() => diagnostics(page)).toBe('');
  }
  await run(page, `import {} from '@cashu/coco-core'; retained;`);
  await expect(result(page)).toHaveText('7');
});
test('function names and replacement references match native JavaScript', async ({ page }) => {
  await run(
    page,
    `
    function named() { return named; }
    const original = named;
    const arrow = () => 1;
    const { callback = function() {} } = {};
    const Box = class { static observed = this.name; };
    [named.name, arrow.name, callback.name, Box.name, Box.observed];
  `,
  );
  await expect(result(page)).toHaveText(
    '[\n  "named",\n  "arrow",\n  "callback",\n  "Box",\n  "Box"\n]',
  );
  await run(page, 'function named() { return 42; } [original.name, original() === named, named()]');
  await expect(result(page)).toHaveText('[\n  "named",\n  true,\n  42\n]');
});
test('restoring a disposed page creates a fresh usable session', async ({ page }) => {
  await run(page, 'const prior = 42;');
  const loaded = page.waitForEvent('load');
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await loaded;
  await expect(page.getByRole('status')).toHaveText('Session 1 · Ready');
  await run(page, 'typeof prior');
  await expect(result(page)).toHaveText('undefined');
});
test('reset interrupts infinite loops and pending promises and cancels old timers', async ({
  page,
}) => {
  await edit(page, `while (true) {}`);
  await page.getByRole('button', { name: /^Run / }).click();
  await expect(page.getByRole('status')).toContainText('Running');
  await page.getByRole('button', { name: /^Reset state/ }).click();
  await expect(page.getByRole('status')).toHaveText('Session 2 · Ready');
  await run(page, `42`);
  await expect(result(page)).toHaveText('42');
  await edit(
    page,
    `setTimeout(() => console.log('STALE TIMER'), 700); await new Promise(() => {});`,
  );
  await page.getByRole('button', { name: /^Run / }).click();
  await expect(page.getByRole('status')).toContainText('Running');
  await page.getByRole('button', { name: /^Reset state/ }).click();
  await expect(page.getByRole('status')).toHaveText('Session 3 · Ready');
  await page.waitForTimeout(800);
  await expect(page.locator('#output')).not.toContainText('STALE TIMER');
});
test('Monaco has syntax colors, typed API completion, prior binding completion and diagnostics', async ({
  page,
}) => {
  await edit(page, 'const highlighted: number = 42;');
  const colors = await page
    .locator('.view-line span[class^="mtk"]')
    .evaluateAll((nodes) => new Set(nodes.map((node) => getComputedStyle(node).color)).size);
  expect(colors).toBeGreaterThan(1);
  await edit(page, 'coco.wallet.');
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.suggest-widget')).toBeVisible();
  await expect(page.locator('.suggest-widget')).toContainText('balances');
  await page.keyboard.press('Escape');
  await run(page, 'const pair = await coco.keyring.generateKeyPair(); pair.publicKeyHex;');
  await edit(page, 'pair.');
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.suggest-widget')).toContainText('publicKeyHex');
  await page.keyboard.press('Escape');
  await edit(page, 'coco.wallet.nonexistentMethod();');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = (window as any).__playground;
        return app.monaco.editor
          .getModelMarkers({ resource: app.editor.getModel().uri })
          .map((marker: any) => marker.message)
          .join('\n');
      }),
    )
    .toContain('nonexistentMethod');
  await edit(page, `import { Amount as LocalAmount } from '@cashu/coco-core'; LocalAmount.`);
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.suggest-widget')).toContainText('from');
  await page.keyboard.press('Escape');
  await edit(page, 'coco.keyring.generateKeyPair');
  await page.evaluate(() => {
    const app = (window as any).__playground;
    app.editor.trigger('test', 'editor.action.showHover', {});
  });
  await expect(page.locator('.monaco-hover')).toContainText('Generates a new keypair');
  await page.keyboard.press('Escape');
  await edit(page, 'coco.keyring.generateKeyPair(');
  await page.keyboard.press('Control+Shift+Space');
  await expect(page.locator('.parameter-hints-widget')).toContainText('generateKeyPair');
  await page.keyboard.press('Escape');
  await edit(page, '42');
  await page.keyboard.press('Control+Enter');
  await expect(result(page)).toHaveText('42');
  await page.keyboard.press('Control+Shift+Enter');
  await expect(page.getByRole('status')).toHaveText('Session 2 · Ready');
  await edit(page, 'pair.publicKeyHex');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = (window as any).__playground;
        return app.monaco.editor
          .getModelMarkers({ resource: app.editor.getModel().uri })
          .map((marker: any) => marker.message)
          .join('\n');
      }),
    )
    .toContain("Cannot find name 'pair'");
});
test('runs offline after loading assets; events and bounded output work', async ({
  page,
  context,
}) => {
  await context.setOffline(true);
  await run(page, `(await coco.keyring.generateKeyPair()).publicKeyHex`);
  await expect(result(page)).toHaveText(/^[0-9a-f]{66}$/);
  await run(page, `for (let i = 0; i < 10000; i++) console.log('entry', i); 42;`);
  await expect(page.getByRole('status')).toContainText('Ready');
  expect(await page.locator('.entry').count()).toBeLessThanOrEqual(500);
  await expect(page.locator('#output')).toContainText('Output limit reached');
  await page.getByRole('tab', { name: /^Events/ }).click();
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-label', 'Events output');
});
test('desktop and narrow layouts keep controls accessible', async ({ page }) => {
  await page.screenshot({ path: 'test-results/playground/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: /^Run/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Reset state/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/playground/mobile.png', fullPage: true });
});
test('mint requests go directly from the worker and committed public events appear', async ({
  page,
  context,
}) => {
  const requests: string[] = [];
  await context.route('https://playground-mint.test/**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    await route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(
        url.pathname === '/v1/info' ? { name: 'Browser mint', nuts: {} } : { keysets: [] },
      ),
    });
  });
  await run(
    page,
    `await coco.mint.addMint('https://playground-mint.test', { trusted: true }); (await coco.mint.getAllMints()).length;`,
  );
  await expect(result(page)).toHaveText('1');
  expect(requests).toEqual(['/v1/info', '/v1/keysets']);
  await page.getByRole('tab', { name: /^Events/ }).click();
  await expect(page.locator('#output')).toContainText('mint:added');
  await expect(page.locator('#output')).toContainText('Browser mint');
});

test('edit and rerun keeps wallet state, replaces bindings and updates completion types', async ({
  page,
}) => {
  await run(page, 'const pair = await coco.keyring.generateKeyPair(); pair.publicKeyHex;');
  const balance = `const balance = await coco.wallet.balances.total(); assert.equal(balance.total.toNumber(), 0); balance.total.toNumber();`;
  for (let i = 0; i < 3; i++) {
    await run(page, balance);
    await expect(result(page)).toHaveText('0');
    await expect(page.locator('.entry[data-level="error"]')).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const app = (window as any).__playground;
          return app.monaco.editor
            .getModelMarkers({ resource: app.editor.getModel().uri })
            .map((marker: any) => marker.message);
        }),
      )
      .toEqual([]);
  }
  await run(
    page,
    'assert.ok(await coco.keyring.getKeyPair(pair.publicKeyHex)); (await coco.keyring.getAllKeyPairs()).length;',
  );
  await expect(result(page)).toHaveText('1');
  const imported = `import { Amount as ImportedAmount } from '@cashu/coco-core'; ImportedAmount.from(42).toNumber();`;
  await run(page, imported);
  await run(page, imported);
  await expect(result(page)).toHaveText('42');
  await run(page, 'const changing = { previous: 1 }; changing;');
  await run(page, 'const changing = { latest: "new" }; changing;');
  await edit(page, 'changing.');
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.suggest-widget')).toContainText('latest');
  await expect(page.locator('.suggest-widget')).not.toContainText('previous');
  await page.keyboard.press('Escape');
  await run(page, 'let counter = 1; const increment = () => ++counter; counter;');
  await run(page, 'counter = 4; increment();');
  await expect(result(page)).toHaveText('5');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = (window as any).__playground;
        return app.monaco.editor
          .getModelMarkers({ resource: app.editor.getModel().uri })
          .map((marker: any) => marker.message);
      }),
    )
    .toEqual([]);
});
