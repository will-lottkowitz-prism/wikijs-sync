import { describe, it, expect } from 'vitest';
import { assetNeedsUpload, assetUploadFailure } from './assetSync';

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

describe('assetUploadFailure', () => {
  it('keeps the server response and adds the size-limit note on 500 and 413', () => {
    for (const status of [500, 413]) {
      const msg = assetUploadFailure(status, '<!DOCTYPE html>oops');
      expect(msg).toContain(`HTTP ${status}): <!DOCTYPE html>oops`);
      expect(msg).toContain('size limit configured in Wiki.js');
    }
  });
  it('adds no note for other statuses', () => {
    expect(assetUploadFailure(401, 'nope')).toBe(
      'Asset upload failed (HTTP 401): nope'
    );
  });
  it('truncates a long response body to 300 chars', () => {
    expect(assetUploadFailure(502, 'x'.repeat(1000))).toBe(
      `Asset upload failed (HTTP 502): ${'x'.repeat(300)}`
    );
  });
});
