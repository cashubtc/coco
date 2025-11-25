import { describe, it, expect } from 'bun:test';
import { normalizeMintUrl } from '../../utils';

describe('normalizeMintUrl', () => {
  describe('real mint URLs', () => {
    it('should handle https://8333.space:3338', () => {
      const url = 'https://8333.space:3338';
      expect(normalizeMintUrl(url)).toBe('https://8333.space:3338');
    });

    it('should handle https://mint.minibits.cash/Bitcoin', () => {
      const url = 'https://mint.minibits.cash/Bitcoin';
      expect(normalizeMintUrl(url)).toBe('https://mint.minibits.cash/Bitcoin');
    });

    it('should handle https://stablenut.cashu.network', () => {
      const url = 'https://stablenut.cashu.network';
      expect(normalizeMintUrl(url)).toBe('https://stablenut.cashu.network');
    });
  });

  describe('trailing slashes', () => {
    it('should remove trailing slash from URL', () => {
      expect(normalizeMintUrl('https://mint.example.com/')).toBe('https://mint.example.com');
    });

    it('should remove trailing slash from URL with path', () => {
      expect(normalizeMintUrl('https://mint.example.com/v1/')).toBe('https://mint.example.com/v1');
    });

    it('should handle URL without trailing slash', () => {
      expect(normalizeMintUrl('https://mint.example.com')).toBe('https://mint.example.com');
    });

    it('should handle root path trailing slash', () => {
      expect(normalizeMintUrl('https://mint.example.com/')).toBe('https://mint.example.com');
    });
  });

  describe('hostname case normalization', () => {
    it('should lowercase uppercase hostname', () => {
      expect(normalizeMintUrl('https://MINT.EXAMPLE.COM')).toBe('https://mint.example.com');
    });

    it('should lowercase mixed case hostname', () => {
      expect(normalizeMintUrl('https://Mint.Example.Com')).toBe('https://mint.example.com');
    });

    it('should preserve path case', () => {
      expect(normalizeMintUrl('https://MINT.EXAMPLE.COM/Bitcoin')).toBe(
        'https://mint.example.com/Bitcoin',
      );
    });

    it('should lowercase hostname but preserve path case for real mint', () => {
      expect(normalizeMintUrl('https://MINT.MINIBITS.CASH/Bitcoin')).toBe(
        'https://mint.minibits.cash/Bitcoin',
      );
    });
  });

  describe('default port removal', () => {
    it('should remove default HTTPS port 443', () => {
      expect(normalizeMintUrl('https://mint.example.com:443')).toBe('https://mint.example.com');
    });

    it('should remove default HTTP port 80', () => {
      expect(normalizeMintUrl('http://mint.example.com:80')).toBe('http://mint.example.com');
    });

    it('should keep non-default HTTPS port', () => {
      expect(normalizeMintUrl('https://mint.example.com:8443')).toBe(
        'https://mint.example.com:8443',
      );
    });

    it('should keep non-default HTTP port', () => {
      expect(normalizeMintUrl('http://mint.example.com:8080')).toBe('http://mint.example.com:8080');
    });

    it('should keep custom port like 3338', () => {
      expect(normalizeMintUrl('https://8333.space:3338')).toBe('https://8333.space:3338');
    });

    it('should remove default port with path', () => {
      expect(normalizeMintUrl('https://mint.example.com:443/v1/info')).toBe(
        'https://mint.example.com/v1/info',
      );
    });
  });

  describe('path normalization', () => {
    it('should normalize redundant path segments', () => {
      expect(normalizeMintUrl('https://mint.example.com/./path')).toBe(
        'https://mint.example.com/path',
      );
    });

    it('should normalize parent directory references', () => {
      expect(normalizeMintUrl('https://mint.example.com/a/../b')).toBe(
        'https://mint.example.com/b',
      );
    });

    it('should normalize multiple slashes in path', () => {
      // Note: URL constructor handles double slashes in path by keeping them
      // This test documents the current behavior
      const result = normalizeMintUrl('https://mint.example.com//path');
      expect(result).toBe('https://mint.example.com//path');
    });
  });

  describe('combined normalizations', () => {
    it('should normalize uppercase hostname with trailing slash', () => {
      expect(normalizeMintUrl('https://MINT.EXAMPLE.COM/')).toBe('https://mint.example.com');
    });

    it('should normalize uppercase hostname with default port and trailing slash', () => {
      expect(normalizeMintUrl('https://MINT.EXAMPLE.COM:443/')).toBe('https://mint.example.com');
    });

    it('should normalize all aspects together', () => {
      expect(normalizeMintUrl('https://MINT.EXAMPLE.COM:443/Path/')).toBe(
        'https://mint.example.com/Path',
      );
    });

    it('should handle complex real-world URL', () => {
      expect(normalizeMintUrl('https://STABLENUT.CASHU.NETWORK:443/')).toBe(
        'https://stablenut.cashu.network',
      );
    });
  });

  describe('idempotency', () => {
    it('should return same result when applied multiple times', () => {
      const url = 'https://MINT.EXAMPLE.COM:443/';
      const normalized = normalizeMintUrl(url);
      expect(normalizeMintUrl(normalized)).toBe(normalized);
      expect(normalizeMintUrl(normalizeMintUrl(normalized))).toBe(normalized);
    });

    it('should be idempotent for real mint URLs', () => {
      const urls = [
        'https://8333.space:3338',
        'https://mint.minibits.cash/Bitcoin',
        'https://stablenut.cashu.network',
      ];

      for (const url of urls) {
        const normalized = normalizeMintUrl(url);
        expect(normalizeMintUrl(normalized)).toBe(normalized);
      }
    });
  });

  describe('edge cases', () => {
    it('should handle URL with query string by stripping it', () => {
      // Query strings are stripped as they're not part of the mint URL identity
      const result = normalizeMintUrl('https://mint.example.com?foo=bar');
      expect(result).toBe('https://mint.example.com');
    });

    it('should handle URL with fragment by stripping it', () => {
      // Fragments are stripped as they're not part of the mint URL identity
      const result = normalizeMintUrl('https://mint.example.com#section');
      expect(result).toBe('https://mint.example.com');
    });

    it('should throw on invalid URL', () => {
      expect(() => normalizeMintUrl('not-a-url')).toThrow();
    });

    it('should throw on empty string', () => {
      expect(() => normalizeMintUrl('')).toThrow();
    });

    it('should handle localhost', () => {
      expect(normalizeMintUrl('http://localhost:3338')).toBe('http://localhost:3338');
    });

    it('should handle IP address', () => {
      expect(normalizeMintUrl('http://127.0.0.1:3338')).toBe('http://127.0.0.1:3338');
    });

    it('should handle IPv6 address', () => {
      expect(normalizeMintUrl('http://[::1]:3338')).toBe('http://[::1]:3338');
    });
  });
});

