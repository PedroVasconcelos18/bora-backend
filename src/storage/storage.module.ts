import { Module } from '@nestjs/common';
import { R2Adapter } from './adapters/r2.adapter';

/**
 * StorageModule binds the 'OBJECT_STORAGE' token to R2Adapter.
 *
 * Mirrors PaymentsModule's 'PAYMENT_PROVIDER' DI-token isolation: consumers
 * (EvidencesService) inject via @Inject('OBJECT_STORAGE') — never the
 * concrete R2Adapter class — so swapping storage providers later means
 * writing a new adapter, not touching EvidencesService.
 */
@Module({
  providers: [
    {
      provide: 'OBJECT_STORAGE',
      useClass: R2Adapter,
    },
  ],
  exports: ['OBJECT_STORAGE'],
})
export class StorageModule {}
