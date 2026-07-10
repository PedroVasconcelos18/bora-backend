import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveStorageDir } from '../storage/storage.constants';

// V1 ephemeral-storage retention: evidence photos only need to survive the
// per-evidence 24h vote window (D-07/D-08). Anything older is dead weight.
const RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Evidence cleanup cron (V1 local-storage design pivot, 2026-07-09).
 *
 * Sweeps the local evidence storage dir hourly and deletes any file whose
 * mtime is older than 24h — the ephemeral counterpart to R2 not being used.
 * Mirrors the DeadlineCancelJob/ReconciliationJob shape exactly: an
 * @Cron(..., { timeZone: 'America/Sao_Paulo' }) `run()` that finds candidates,
 * acts on each, and logs a single `found/acted` line.
 *
 * Idempotent by construction: a file deleted on one tick is simply gone on the
 * next, and the mtime check makes re-runs harmless. Empty directories left
 * behind are pruned best-effort so the tree doesn't accrete stale folders.
 */
@Injectable()
export class EvidenceCleanupJob {
  private readonly logger = new Logger(EvidenceCleanupJob.name);
  private readonly storageDir: string;

  constructor(config: ConfigService) {
    this.storageDir = resolveStorageDir(config);
  }

  @Cron('0 * * * *', { timeZone: 'America/Sao_Paulo' }) // hourly, timezone-aware
  async run(): Promise<void> {
    const cutoff = Date.now() - RETENTION_MS;
    let scanned = 0;
    let deleted = 0;

    const walk = async (dir: string): Promise<void> => {
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // dir missing (nothing uploaded yet) — nothing to sweep
      }

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          // best-effort prune of a now-empty directory
          await fs.rmdir(full).catch(() => undefined);
          continue;
        }
        scanned++;
        try {
          const stat = await fs.stat(full);
          if (stat.mtimeMs < cutoff) {
            await fs.unlink(full);
            deleted++;
          }
        } catch {
          // raced with another delete / unreadable — skip
        }
      }
    };

    await walk(this.storageDir);

    this.logger.log(
      `evidence-cleanup: scanned=${scanned} deleted=${deleted} at=${new Date().toISOString()}`,
    );
  }
}
