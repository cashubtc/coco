import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PollingTransport } from '../../infra/PollingTransport';
import { NullLogger } from '../../logging';

describe('PollingTransport per-mint intervals', () => {
  let transport: PollingTransport;
  const mintUrl1 = 'https://mint1.example.com';
  const mintUrl2 = 'https://mint2.example.com';

  beforeEach(() => {
    transport = new PollingTransport({ intervalMs: 5000 }, new NullLogger());
  });

  it('should use default interval when no per-mint interval is set', () => {
    // Access private method via casting for testing
    const getInterval = (transport as any).getIntervalForMint.bind(transport);
    expect(getInterval(mintUrl1)).toBe(5000);
  });

  it('should use per-mint interval when set', () => {
    transport.setIntervalForMint(mintUrl1, 1000);

    const getInterval = (transport as any).getIntervalForMint.bind(transport);
    expect(getInterval(mintUrl1)).toBe(1000);
  });

  it('should not affect other mints when setting per-mint interval', () => {
    transport.setIntervalForMint(mintUrl1, 1000);

    const getInterval = (transport as any).getIntervalForMint.bind(transport);
    expect(getInterval(mintUrl1)).toBe(1000);
    expect(getInterval(mintUrl2)).toBe(5000); // Default
  });

  it('should allow updating per-mint interval', () => {
    transport.setIntervalForMint(mintUrl1, 1000);
    transport.setIntervalForMint(mintUrl1, 2000);

    const getInterval = (transport as any).getIntervalForMint.bind(transport);
    expect(getInterval(mintUrl1)).toBe(2000);
  });

  it('should clear per-mint interval on closeMint', () => {
    transport.setIntervalForMint(mintUrl1, 1000);
    transport.closeMint(mintUrl1);

    const getInterval = (transport as any).getIntervalForMint.bind(transport);
    expect(getInterval(mintUrl1)).toBe(5000); // Back to default
  });

  it('should clear all per-mint intervals on closeAll', () => {
    transport.setIntervalForMint(mintUrl1, 1000);
    transport.setIntervalForMint(mintUrl2, 2000);
    transport.closeAll();

    const getInterval = (transport as any).getIntervalForMint.bind(transport);
    expect(getInterval(mintUrl1)).toBe(5000); // Back to default
    expect(getInterval(mintUrl2)).toBe(5000); // Back to default
  });

  it('should support different intervals for different mints', () => {
    transport.setIntervalForMint(mintUrl1, 1000);
    transport.setIntervalForMint(mintUrl2, 3000);

    const getInterval = (transport as any).getIntervalForMint.bind(transport);
    expect(getInterval(mintUrl1)).toBe(1000);
    expect(getInterval(mintUrl2)).toBe(3000);
  });
});

