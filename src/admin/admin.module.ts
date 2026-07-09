import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';

/**
 * AdminModule — the env-secret-gated refund/cancellation queue (PAY-08,
 * D-10/D-11). PrismaService and ConfigService are both @Global (registered
 * with isGlobal: true / @Global() decorator), so no explicit imports are
 * needed to reach them here.
 */
@Module({
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
