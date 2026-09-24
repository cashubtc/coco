import { describe, it, expect } from 'bun:test';
import { normalizeMintUrl } from '../../utils';

describe('normalizeMintUrl', () => {
  describe('trailing slashes', () => {
    it('should remove trailing slash from URL', () => {
      expect(normalizeMintUrl('https://mint.example.com/')).toBe('https://mint.example.com');
    });

    it('should remove trailing slash from URL with path', () => {
      expect(normalizeMintUrl('https://mint.example.com/v1/')).toBe('https://mint.example.com/v1');
    });
  });

  describe('hostname case normalization', () => {
    it('should preserve path case', () => {
      expect(normalizeMintUrl('https://MINT.EXAMPLE.COM/Bitcoin')).toBe(
        'https://mint.example.com/Bitcoin',
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
    it('should normalize all aspects together', () => {
      expect(normalizeMintUrl('https://MINT.EXAMPLE.COM:443/Path/')).toBe(
        'https://mint.example.com/Path',
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

    it('should handle IPv6 address', () => {
      expect(normalizeMintUrl('http://[::1]:3338')).toBe('http://[::1]:3338');
    });
  });
});
