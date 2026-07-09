import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { IEmailProvider } from '../email/interfaces/email-provider.interface';
import { PaymentsService, CashInResult } from '../payments/payments.service';

export interface InviteWithLink {
  inviteId: string;
  token: string;
  targetEmail: string;
  copyableLink: string;
}

export interface InvitePreview {
  targetEmail: string;
  challenge: {
    id: string;
    title: string;
    emoji: string;
    durationDays: number;
    collabAmount: string;
    platformFee: string;
    status: string;
  };
}

export interface AcceptResult {
  participantId: string;
  challengeId: string;
  status: string;
  paidAt: Date | null;
}

export interface AcceptAndPayResult extends CashInResult {
  participantId: string;
  challengeId: string;
}

@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);
  private readonly appDomain: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject('EMAIL_PROVIDER') private readonly emailProvider: IEmailProvider,
    private readonly paymentsService: PaymentsService,
  ) {
    // Use FRONTEND_URL to build invite links; fall back to localhost for dev
    this.appDomain =
      this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:5173';
  }

  /**
   * Validate a PENDING invite token and return the challenge summary + targetEmail.
   * Public endpoint — no auth required (AUTH-04 viewing is unrestricted).
   * Throws NotFoundException for unknown or non-PENDING tokens.
   */
  async validate(token: string): Promise<InvitePreview> {
    const invite = await this.prisma.invite.findUnique({
      where: { token },
      include: {
        challenge: {
          select: {
            id: true,
            title: true,
            emoji: true,
            durationDays: true,
            collabAmount: true,
            platformFee: true,
            status: true,
          },
        },
      },
    });

    if (!invite || invite.status !== 'PENDING') {
      throw new NotFoundException('Convite inválido ou expirado.');
    }

    return {
      targetEmail: invite.targetEmail,
      challenge: {
        id: invite.challenge.id,
        title: invite.challenge.title,
        emoji: invite.challenge.emoji,
        durationDays: invite.challenge.durationDays,
        collabAmount: invite.challenge.collabAmount.toString(),
        platformFee: invite.challenge.platformFee.toString(),
        status: invite.challenge.status,
      },
    };
  }

  /**
   * Accept an invite.
   * AUTH-05 (D-02): user.email must match invite.targetEmail (case-insensitive).
   * If they don't match, throw ForbiddenException with both emails in the message.
   * Creates Participant (status INVITED, paidAt null) in a $transaction with invite ACCEPTED.
   * Does NOT set paidAt and does NOT touch challenge.status (D-11).
   */
  async accept(token: string, userId: string): Promise<AcceptResult> {
    // Load the invite (must be PENDING)
    const invite = await this.prisma.invite.findUnique({
      where: { token },
    });

    if (!invite || invite.status !== 'PENDING') {
      throw new NotFoundException('Convite inválido ou expirado.');
    }

    // Load the authenticated user
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Usuário não encontrado.');
    }

    // AUTH-05 (D-02): Enforce email binding at the DATA/service layer
    if (user.email.toLowerCase() !== invite.targetEmail.toLowerCase()) {
      throw new ForbiddenException(
        `Este convite é para ${invite.targetEmail}. Você está logado como ${user.email}. Entre com a conta correta para aceitar.`,
      );
    }

    // Run accept in a $transaction: update invite + create participant (T-01-16: idempotent via @@unique)
    const participant = await this.prisma.$transaction(async (tx) => {
      await tx.invite.update({
        where: { id: invite.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });

      // @@unique([challengeId, userId]) — upsert handles the double-accept idempotently
      const existing = await tx.participant.findUnique({
        where: { challengeId_userId: { challengeId: invite.challengeId, userId: user.id } },
      });

      if (existing) {
        // Already a participant — return existing (idempotent path)
        return existing;
      }

      return tx.participant.create({
        data: {
          challengeId: invite.challengeId,
          userId: user.id,
          status: 'INVITED',
          // paidAt intentionally null — D-11: accept does NOT mark paid
        },
      });
    });

    return {
      participantId: participant.id,
      challengeId: participant.challengeId,
      status: participant.status,
      paidAt: participant.paidAt,
    };
  }

  /**
   * Accept an invite and immediately create the Pix charge in one flow (D-06).
   * Runs the existing accept() transaction first to guarantee the Participant
   * exists (idempotent on double-accept), then delegates to
   * PaymentsService.createCashIn — the same charge path the creator's
   * "pagar minha entrada" endpoint uses.
   */
  async acceptAndPay(
    token: string,
    userId: string,
    pixKey?: string,
  ): Promise<AcceptAndPayResult> {
    const accepted = await this.accept(token, userId);
    const cashIn = await this.paymentsService.createCashIn(accepted.participantId, pixKey);

    return {
      ...cashIn,
      participantId: accepted.participantId,
      challengeId: accepted.challengeId,
    };
  }

  /**
   * Create Invite rows for a list of emails and dispatch invitation emails.
   * Returns copyable invite links for each invitee.
   *
   * NOTE: This method does NOT create the Invite rows — the caller (ChallengesService)
   * creates them inside a $transaction. This method takes already-persisted invite
   * tokens and dispatches emails + returns the links.
   */
  async dispatchInvites(
    challengeId: string,
    challengeTitle: string,
    challengeEmoji: string,
    invites: Array<{ token: string; targetEmail: string }>,
  ): Promise<InviteWithLink[]> {
    const results: InviteWithLink[] = [];

    for (const invite of invites) {
      const copyableLink = `${this.appDomain}/invites/${invite.token}`;

      // Send invite email (dev mode: logs to console if RESEND_API_KEY unset)
      try {
        await this.emailProvider.send({
          to: invite.targetEmail,
          subject: `${challengeEmoji} Você foi convidado para o desafio "${challengeTitle}" no Bora`,
          html: this.buildInviteEmailHtml({
            challengeTitle,
            challengeEmoji,
            copyableLink,
          }),
        });
      } catch (err) {
        // Email failure must not abort the creation flow — log and continue
        this.logger.error(
          `Failed to send invite email to ${invite.targetEmail}: ${String(err)}`,
        );
      }

      results.push({
        inviteId: challengeId,
        token: invite.token,
        targetEmail: invite.targetEmail,
        copyableLink,
      });
    }

    return results;
  }

  private buildInviteEmailHtml(params: {
    challengeTitle: string;
    challengeEmoji: string;
    copyableLink: string;
  }): string {
    return `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; background: #EFE8DA; padding: 24px;">
  <div style="max-width: 480px; margin: 0 auto; background: #FAF7F0; border-radius: 20px; padding: 28px; box-shadow: 0 18px 40px -22px rgba(11,59,34,.42);">
    <div style="text-align: center; margin-bottom: 20px;">
      <div style="font-size: 3rem;">${params.challengeEmoji}</div>
      <h1 style="font-family: 'Baloo 2', sans-serif; color: #0B3B22; margin: 8px 0 4px;">${params.challengeTitle}</h1>
      <p style="color: #5C6B61; font-size: 14px;">Você foi convidado para um desafio de hábito!</p>
    </div>
    <a href="${params.copyableLink}" style="display: block; background: #2BD86B; color: #0B3B22; text-decoration: none; padding: 14px 22px; border-radius: 16px; text-align: center; font-weight: 700; font-size: 16px; margin-bottom: 16px;">
      Aceitar convite
    </a>
    <p style="font-size: 13px; color: #5C6B61; text-align: center;">Ou copie este link: <a href="${params.copyableLink}" style="color: #12B85C;">${params.copyableLink}</a></p>
    <div style="margin-top: 20px; background: #16241C; color: #FAF7F0; border-radius: 14px; padding: 14px 16px; font-size: 12px; line-height: 1.5;">
      O <strong style="color: #2BD86B;">Bora</strong> é uma plataforma de gerenciamento de desafios de hábito entre amigos. <strong style="color: #2BD86B;">Não é aposta nem bolão</strong>: a colaboração funciona como incentivo e volta pra quem mantém o hábito combinado.
    </div>
  </div>
</body>
</html>`;
  }
}
