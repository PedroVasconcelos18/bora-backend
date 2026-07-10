import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { R2Adapter } from './adapters/r2.adapter';
import { LocalStorageAdapter } from './adapters/local-storage.adapter';
import { StorageController } from './storage.controller';

/**
 * StorageModule binds the 'OBJECT_STORAGE' token to a concrete adapter,
 * selected by the STORAGE_DRIVER env var — **default 'local'** (V1 design
 * pivot, 2026-07-09: evidence photos are ephemeral, kept 24h then swept by
 * EvidenceCleanupJob, and stored on the backend's own filesystem).
 *
 * Both adapters are registered so the swap is env-only: set STORAGE_DRIVER=r2
 * (plus the R2_* env vars) to route uploads back to presigned-direct-to-R2
 * without touching EvidencesService — the whole point of the adapter
 * isolation. R2Adapter is kept intact for exactly this future swap-back.
 *
 * Consumers (EvidencesService) inject via @Inject('OBJECT_STORAGE') — never a
 * concrete class. StorageController injects LocalStorageAdapter directly
 * because it IS the local backend's transport (sig verification + on-disk
 * path resolution are local-only concerns).
 */
@Module({
  controllers: [StorageController],
  providers: [
    R2Adapter,
    LocalStorageAdapter,
    {
      provide: 'OBJECT_STORAGE',
      useFactory: (config: ConfigService, local: LocalStorageAdapter, r2: R2Adapter) =>
        config.get<string>('STORAGE_DRIVER') === 'r2' ? r2 : local,
      inject: [ConfigService, LocalStorageAdapter, R2Adapter],
    },
  ],
  exports: ['OBJECT_STORAGE'],
})
export class StorageModule {}
