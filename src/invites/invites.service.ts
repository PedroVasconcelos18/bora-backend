import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
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

export interface PendingInvite {
  id: string;
  email: string;
  status: string;
  createdAt: Date;
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
    private readonly eventEmitter: EventEmitter2,
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
   * List still-pending invites for a challenge (feedback QA 5a). Creator-only:
   * the invitee-management list (edit email / delete) is a creator affordance,
   * so a non-creator gets a ForbiddenException rather than the list.
   */
  async listPendingForChallenge(challengeId: string, userId: string): Promise<PendingInvite[]> {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      select: { id: true, creatorId: true },
    });
    if (!challenge) {
      throw new NotFoundException('Desafio não encontrado.');
    }
    if (challenge.creatorId !== userId) {
      throw new ForbiddenException('Só o criador pode ver os convites deste desafio.');
    }

    const invites = await this.prisma.invite.findMany({
      where: { challengeId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });

    return invites.map((i) => ({
      id: i.id,
      email: i.targetEmail,
      status: i.status,
      createdAt: i.createdAt,
    }));
  }

  /**
   * Load a PENDING invite and assert the caller created its challenge — the
   * shared guard for the creator-only edit/delete actions below. Rejects a
   * non-creator (Forbidden) and an already-accepted/expired invite (Conflict,
   * a consumed invite has a Participant row and editing the email would be a
   * no-op that silently diverges from reality).
   */
  private async loadEditableInvite(inviteId: string, userId: string) {
    const invite = await this.prisma.invite.findUnique({
      where: { id: inviteId },
      include: { challenge: true },
    });
    if (!invite) {
      throw new NotFoundException('Convite não encontrado.');
    }
    if (invite.challenge.creatorId !== userId) {
      throw new ForbiddenException('Só o criador pode gerenciar os convites deste desafio.');
    }
    if (invite.status !== 'PENDING') {
      throw new ConflictException('Este convite já foi aceito e não pode mais ser alterado.');
    }
    return invite;
  }

  /**
   * Edit a pending invite's target email (feedback QA 5a) and re-dispatch the
   * invitation to the new address. Creator-only, PENDING-only.
   */
  async updateEmail(inviteId: string, userId: string, targetEmail: string): Promise<PendingInvite> {
    const invite = await this.loadEditableInvite(inviteId, userId);
    const email = targetEmail.trim();

    const updated = await this.prisma.invite.update({
      where: { id: inviteId },
      data: { targetEmail: email },
    });

    // Reenvia o convite (email + notificação) pro novo endereço. Reaproveita o
    // mesmo dispatch da criação — falha de email não aborta (log e segue).
    await this.dispatchInvites(
      invite.challengeId,
      invite.challenge.title,
      invite.challenge.emoji,
      [{ token: updated.token, targetEmail: updated.targetEmail }],
    );

    return {
      id: updated.id,
      email: updated.targetEmail,
      status: updated.status,
      createdAt: updated.createdAt,
    };
  }

  /**
   * Re-dispatch a pending invite to its CURRENT email without changing it
   * (feedback: botão "reenviar convite"). Creator-only, PENDING-only. Reuses
   * the existing token (link stays valid) and the same dispatch path as
   * creation — email failure is logged, not fatal. Distinct from updateEmail:
   * gives the creator an explicit resend affordance for the "e-mail ficou
   * igual" case, where re-saving the edit was a confusing no-op.
   */
  async resend(inviteId: string, userId: string): Promise<PendingInvite> {
    const invite = await this.loadEditableInvite(inviteId, userId);

    await this.dispatchInvites(
      invite.challengeId,
      invite.challenge.title,
      invite.challenge.emoji,
      [{ token: invite.token, targetEmail: invite.targetEmail }],
    );

    return {
      id: invite.id,
      email: invite.targetEmail,
      status: invite.status,
      createdAt: invite.createdAt,
    };
  }

  /**
   * Delete a pending invite (feedback QA 5a). Creator-only, PENDING-only.
   */
  async remove(inviteId: string, userId: string): Promise<{ id: string; removed: true }> {
    await this.loadEditableInvite(inviteId, userId);
    await this.prisma.invite.delete({ where: { id: inviteId } });
    return { id: inviteId, removed: true };
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

      // NOTIF-02 (D-02): unconditional — even if the email send above
      // failed, the notification and the email are independent channels.
      // The listener resolves a User by targetEmail; no account yet is a
      // silent no-op, not an error (Pitfall 4).
      this.eventEmitter.emit('invite.sent', {
        inviteId: invite.token,
        targetEmail: invite.targetEmail,
        challengeId,
      });

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
