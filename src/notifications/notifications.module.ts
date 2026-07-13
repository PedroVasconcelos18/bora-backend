import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsListener } from './notifications.listener';

// PrismaModule is @Global() (see prisma/prisma.module.ts) — no need to import
// it here. The event bus module is also registered globally in AppModule
// (D-01), so EventEmitter2 is DI-injectable without an explicit import.
// NotificationsListener (NOTIF-02) is the only @OnEvent consumer in the
// codebase — registered here as a plain provider (never exported, nothing
// else needs to inject it; it is discovered automatically via
// @nestjs/event-emitter's DiscoveryService scan of all app providers).
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsListener],
  exports: [NotificationsService],
})
export class NotificationsModule {}
