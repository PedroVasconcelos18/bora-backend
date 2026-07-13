import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, NotificationType } from '../generated/prisma/client.js';

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  entityId: string;
  payload: Record<string, unknown>;
}

const LIST_TAKE_DEFAULT = 30;
const LIST_TAKE_MIN = 1;
const LIST_TAKE_MAX = 100;

/**
 * Owns the notifications table. All 6 methods are userId-scoped by the
 * caller (NotificationsController resolves userId from @CurrentUser(), never
 * a client-supplied value — see T-09-01/02/03/04 in the phase threat model).
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Single-row create. A P2002 (duplicate on @@unique([userId,type,entityId]))
   * is a legitimate no-op — e.g. a duplicate webhook delivery or a
   * reconciliation job re-running — and is swallowed silently (D-02/D-03
   * fire-and-forget discipline: this is called from an @OnEvent listener,
   * never blocking the domain flow that emitted the event). Any other error
   * is re-thrown.
   */
  async create(input: CreateNotificationInput): Promise<void> {
    try {
      await this.prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          entityId: input.entityId,
          payload: input.payload as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return;
      }
      throw err;
    }
  }

  /**
   * Batch create for fan-out (D-04 group events). `skipDuplicates: true`
   * gives the same dedupe semantics as `create()`'s caught P2002, in a
   * single query instead of N.
   */
  async createMany(inputs: CreateNotificationInput[]): Promise<void> {
    if (inputs.length === 0) {
      return;
    }

    await this.prisma.notification.createMany({
      data: inputs.map((input) => ({
        userId: input.userId,
        type: input.type,
        entityId: input.entityId,
        payload: input.payload as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
  }

  /**
   * GET /notifications — the caller's own notifications, newest first.
   * `take` defaults to 30 and is clamped to [1, 100] (Claude's Discretion,
   * CONTEXT.md: simple offset-less "most recent N", no cursor pagination —
   * no other endpoint in this backend paginates today).
   */
  async list(userId: string, take?: number) {
    const clampedTake = Math.min(
      LIST_TAKE_MAX,
      Math.max(LIST_TAKE_MIN, take ?? LIST_TAKE_DEFAULT),
    );

    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: clampedTake,
    });
  }

  /** GET /notifications/unread-count — the caller's own unread count. */
  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  /**
   * PATCH /notifications/:id/read — T-09-01 mitigation: the WHERE clause is
   * the atomic ownership barrier (never `findUnique` then `update`, which
   * would open a TOCTOU race and leak existence). `count === 0` means either
   * the row doesn't exist OR it isn't the caller's — both collapse to the
   * same 404, so there is no enumeration oracle (T-09-03).
   */
  async markRead(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { readAt: new Date() },
    });

    if (count === 0) {
      throw new NotFoundException('Notificação não encontrada.');
    }
  }

  /**
   * POST /notifications/read-all — marks all of the caller's unread
   * notifications as read. Never throws: zero unread rows is a legitimate
   * no-op, not an error.
   */
  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
  }
}
