import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

// PrismaModule is @Global() (see prisma/prisma.module.ts) — no need to import
// it here. The event bus module is also registered globally in AppModule
// (D-01), so EventEmitter2 is DI-injectable without an explicit import.
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
