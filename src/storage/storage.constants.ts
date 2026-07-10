import * as path from 'path';

// V5 (RESEARCH.md Security Domain): MIME allowlist shared by the presign DTO,
// the local storage adapter, and the local StorageController's PUT gate — one
// source of truth so the three can never disagree about what an "image" is.
export const ALLOWED_IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

// Upload size cap, enforced both when streaming bytes through the local
// StorageController and (implicitly) as the presign contract's ceiling.
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB

// A3 (RESEARCH.md Assumptions Log): short-lived presign TTL — the client PUTs
// almost immediately after minting. Kept small so a leaked signed URL is only
// briefly usable.
export const PRESIGN_TTL_SECONDS = 300; // 5 minutes

/**
 * Resolves the local evidence storage directory (V1 ephemeral store).
 * Defaults to `<cwd>/var/evidences` — the backend runs with cwd=bora-backend,
 * so this is `bora-backend/var/evidences` (gitignored, created at boot).
 */
export function resolveStorageDir(config: { get(key: string): string | undefined }): string {
  const configured = config.get('LOCAL_STORAGE_DIR');
  return configured && configured.trim()
    ? path.resolve(configured)
    : path.resolve(process.cwd(), 'var/evidences');
}
