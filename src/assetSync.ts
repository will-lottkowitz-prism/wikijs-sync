// Pure decision for re-uploading an asset that already exists on the server.
// No VS Code API, so it is unit-testable on its own (see assetSync.unit.test.ts).

export interface LocalAssetStat {
  size: number;
  mtimeMs: number;
}

export interface RemoteAssetStat {
  fileSize: number;
  /** ISO timestamp of the server's last upload of this asset. */
  updatedAt: string;
}

/**
 * Whether a local asset should replace the server's copy: its size differs, or
 * it was modified after the server last stored it. `updatedAt` is the upload
 * time, not the file's age, so a fresh checkout (every mtime = now) re-uploads
 * once; a same-size edit with an older mtime is not detected.
 */
export const assetNeedsUpload = (
  local: LocalAssetStat,
  remote: RemoteAssetStat
): boolean => {
  if (local.size !== remote.fileSize) return true;
  const remoteMs = Date.parse(remote.updatedAt);
  if (Number.isNaN(remoteMs)) return true;
  return local.mtimeMs > remoteMs;
};

/**
 * Message for a failed asset upload. The server's response is kept as is (it can
 * be a whole HTML error page, so only the start); a 500 or 413 usually means the
 * file is over Wiki.js's upload size limit, so say so.
 */
export const assetUploadFailure = (status: number, body: string): string => {
  const base = `Asset upload failed (HTTP ${status}): ${body.slice(0, 300)}`;
  return status === 500 || status === 413
    ? `${base}\n  Note: is the file above the size limit configured in Wiki.js (Admin > Site > Uploads)?`
    : base;
};
