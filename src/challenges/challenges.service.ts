import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InvitesService, InviteWithLink } from '../invites/invites.service';
import { CreateChallengeDto } from './dto/create-challenge.dto';

export interface ChallengeWithLinks {
  id: string;
  title: string;
  emoji: string;
  durationDays: number;
  collabAmount: string;
  platformFee: string;
  status: string;
  creatorId: string;
  createdAt: Date;
  copyableLinks: InviteWithLink[];
}

@Injectable()
export class ChallengesService {
  private readonly logger = new Logger(ChallengesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invitesService: InvitesService,
  ) {}

  /**
   * Create a challenge in WAITING status:
   * 1. In a single $transaction: persist Challenge, creator Participant (INVITED, paidAt null), and Invite rows.
   * 2. Dispatch invite emails via InvitesService (outside the transaction — email failure must not roll back DB writes).
   * 3. Return the challenge + copyable invite links.
   *
   * D-11: Creator is NOT marked as paid. No ACTIVE status. No payment code.
   */
  async create(
    dto: CreateChallengeDto,
    creatorId: string,
  ): Promise<ChallengeWithLinks> {
    // Run DB writes in a single transaction
    const { challenge, inviteTokens } = await this.prisma.$transaction(
      async (tx) => {
        // 1. Create challenge in WAITING
        const challenge = await tx.challenge.create({
          data: {
            title: dto.title,
            emoji: dto.emoji,
            durationDays: dto.durationDays,
            collabAmount: dto.collabAmount,
            platformFee: 10,
            status: 'WAITING',
            creatorId,
          },
        });

        // 2. Create creator Participant (INVITED, paidAt null — D-11 zero money)
        await tx.participant.create({
          data: {
            challengeId: challenge.id,
            userId: creatorId,
            status: 'INVITED',
            paidAt: null,
          },
        });

        // 3. Create one Invite per invitee email
        const inviteTokens: Array<{ token: string; targetEmail: string }> = [];
        for (const email of dto.invitees) {
          const invite = await tx.invite.create({
            data: {
              challengeId: challenge.id,
              targetEmail: email.toLowerCase().trim(),
              status: 'PENDING',
            },
          });
          inviteTokens.push({ token: invite.token, targetEmail: invite.targetEmail });
        }

        return { challenge, inviteTokens };
      },
    );

    // Dispatch invite emails outside the transaction (email failure must not roll back)
    const copyableLinks = await this.invitesService.dispatchInvites(
      challenge.id,
      challenge.title,
      challenge.emoji,
      inviteTokens,
    );

    return {
      id: challenge.id,
      title: challenge.title,
      emoji: challenge.emoji,
      durationDays: challenge.durationDays,
      collabAmount: challenge.collabAmount.toString(),
      platformFee: challenge.platformFee.toString(),
      status: challenge.status,
      creatorId: challenge.creatorId,
      createdAt: challenge.createdAt,
      copyableLinks,
    };
  }

  /**
   * List all challenges where the caller is the creator.
   */
  async list(creatorId: string) {
    const challenges = await this.prisma.challenge.findMany({
      where: { creatorId },
      include: {
        participants: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
        invites: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return challenges.map((c) => ({
      ...c,
      collabAmount: c.collabAmount.toString(),
      platformFee: c.platformFee.toString(),
    }));
  }

  /**
   * Get a single challenge by ID (with participants + invites).
   */
  async get(id: string) {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id },
      include: {
        participants: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
        invites: true,
      },
    });

    if (!challenge) return null;

    return {
      ...challenge,
      collabAmount: challenge.collabAmount.toString(),
      platformFee: challenge.platformFee.toString(),
    };
  }
}
