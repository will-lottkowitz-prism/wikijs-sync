import { describe, it, expect } from 'vitest';
import { assetNeedsUpload } from './assetSync';

const remote = { fileSize: 100, updatedAt: '2026-10-01T12:00:00.000Z' };
const t = Date.parse('2026-10-01T12:00:00.000Z');

describe('assetNeedsUpload', () => {
  it('skips an unchanged asset', () => {
    expect(assetNeedsUpload({ size: 100, mtimeMs: t - 1000 }, remote)).toBe(
      false
    );
    expect(assetNeedsUpload({ size: 100, mtimeMs: t }, remote)).toBe(false);
  });
  it('uploads when the size differs', () => {
    expect(assetNeedsUpload({ size: 101, mtimeMs: t - 1000 }, remote)).toBe(
      true
    );
  });
  it('uploads when modified after the server copy', () => {
    expect(assetNeedsUpload({ size: 100, mtimeMs: t + 1000 }, remote)).toBe(
      true
    );
  });
  it('uploads when the server timestamp is unusable', () => {
    expect(
      assetNeedsUpload({ size: 100, mtimeMs: t }, { ...remote, updatedAt: 'x' })
    ).toBe(true);
  });
});
