import { Module } from '@nestjs/common';
import { EvidencesController } from './evidences.controller';
import { EvidencesService } from './evidences.service';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [EvidencesController],
  providers: [EvidencesService],
  exports: [EvidencesService],
})
export class EvidencesModule {}
