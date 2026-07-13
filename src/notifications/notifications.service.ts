import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Minimal stub — fleshed out in Task 3 of this same plan (09-01) with
 * create/createMany/list/unreadCount/markRead/markAllRead. Exists here only
 * so NotificationsModule/AppModule compile after Task 1.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}
}
