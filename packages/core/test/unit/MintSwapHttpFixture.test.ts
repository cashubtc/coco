import { afterEach, describe, expect, it } from 'bun:test';

import { MintSwapHttpFixture } from '../fixtures/MintSwapHttpFixture.ts';

describe('MintSwapHttpFixture', () => {
  const fixtures: MintSwapHttpFixture[] = [];
  afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.stop()));

  it('preserves remote melt truth when the response is lost after commit', async () => {
    const fixture = new MintSwapHttpFixture();
    fixtures.push(fixture);
    fixture.start();
    fixture.failNext('melt:after-commit');

    const lost = await fetch(`${fixture.url}/v1/melt/bolt11`, {
      method: 'POST',
      body: JSON.stringify({ quote: 'source-quote', inputs: [] }),
    });
    expect(lost.status).toBe(503);
    expect(fixture.meltState).toBe('PENDING');
    fixture.meltState = 'PAID';
    fixture.meltChange = [{ amount: 2 }];
    const observed = await fetch(`${fixture.url}/v1/melt/quote/bolt11/source-quote`);
    expect(await observed.json()).toMatchObject({ state: 'PAID', change: [{ amount: 2 }] });
    expect(fixture.calls.filter((call) => call.path === '/v1/melt/bolt11')).toHaveLength(1);
  });

  it('restores issued signatures after an ambiguous destination response', async () => {
    const fixture = new MintSwapHttpFixture();
    fixtures.push(fixture);
    fixture.start();
    fixture.mintState = 'PAID';
    fixture.issuedSignatures = [{ id: 'keyset', amount: 100, C_: 'signature' }];
    fixture.restoredSignatures = fixture.issuedSignatures;
    fixture.failNext('mint:after-commit');

    const lost = await fetch(`${fixture.url}/v1/mint/bolt11`, {
      method: 'POST',
      body: JSON.stringify({ quote: 'destination-quote', outputs: [{ amount: 100 }] }),
    });
    expect(lost.status).toBe(503);
    expect(fixture.mintState as string).toBe('ISSUED');
    const restored = await fetch(`${fixture.url}/v1/restore`, {
      method: 'POST',
      body: JSON.stringify({ outputs: [{ amount: 100 }] }),
    });
    expect(await restored.json()).toMatchObject({ signatures: fixture.issuedSignatures });
    expect(fixture.calls.filter((call) => call.path === '/v1/mint/bolt11')).toHaveLength(1);
  });
});
