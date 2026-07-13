import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { IEmailProvider } from '../email/interfaces/email-provider.interface';
import { AuthService, hashRefreshToken } from './auth.service';

/**
 * Password reset token lifecycle (PWD-01/PWD-02) — a sibling service inside
 * AuthModule, not a standalone module: this composes AuthService.logout()
 * (D-05) and the EmailModule adapter (D-06), both of which already live in
 * AuthModule's blast radius.
 *
 * Security invariants (do not weaken):
 * - The raw token is never persisted or logged — only its SHA-256 hash.
 * - requestPasswordReset() is silent for a non-existent user (anti-enumeration).
 * - The reset email is fire-and-forget — never awaited on the response path
 *   (timing-based enumeration would otherwise reopen exactly the channel the
 *   uniform 200 response closes).
 * - A dead token (invalid/expired/used) on POST responds with BadRequestException
 *   (400), never the 401 exception used elsewhere in this module for dead
 *   refresh tokens — see the plan's <api_contract>: a 401 here would trigger
 *   fetchWithRefresh's silent-refresh-and-replay for an authed visitor,
 *   double-submitting the password change.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly appDomain: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly authService: AuthService,
    @Inject('EMAIL_PROVIDER') private readonly emailProvider: IEmailProvider,
  ) {
    this.appDomain =
      this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:5173';
  }

  /**
   * PWD-01. Always resolves without throwing — the controller returns the
   * same uniform response regardless of whether the account exists (D-06).
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    // Anti-enumeration: silently no-op for an unknown account. No exception,
    // no log containing the email — the controller responds 200 either way.
    if (!user) {
      return;
    }

    // D-04: requesting a new link revokes any still-active tokens for this
    // user — only the most recent email works.
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const rawToken = crypto.randomUUID();
    const tokenHash = hashRefreshToken(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h — D-02

    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    const resetLink = `${this.appDomain}/reset-password/${rawToken}`;

    // D-06: fire-and-forget — must NOT be awaited on the response path. This
    // is a security control (timing-based enumeration), not an optimization.
    // Failure only logs and never surfaces to the caller.
    void this.emailProvider
      .send({
        to: user.email,
        subject: 'Recuperar senha — Bora',
        html: this.buildPasswordResetEmailHtml({ resetLink }),
      })
      .catch((err: unknown) => {
        this.logger.error(
          `Failed to send password reset email to ${user.email}: ${String(err)}`,
        );
      });
  }

  /**
   * D-11 #2. Never throws — a bad/unknown token is simply { valid: false },
   * not a 404. Invalid, expired, and used tokens all collapse into the same
   * false (D-13) so a stranger can't distinguish "never existed" from
   * "existed but died".
   */
  async validateResetToken(rawToken: string): Promise<{ valid: boolean }> {
    const stored = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashRefreshToken(rawToken) },
    });

    const valid =
      !!stored && stored.usedAt === null && stored.expiresAt > new Date();

    return { valid };
  }

  /**
   * PWD-02. Re-validates the token inside the transaction (the race between
   * the mount GET and the submit POST is real), swaps the passwordHash with
   * the same scheme used at signup, marks the token used (single-use, D-03),
   * then revokes every active session for the user (D-05) once the
   * transaction has committed.
   */
  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const tokenHash = hashRefreshToken(rawToken);

    const userId = await this.prisma.$transaction(async (tx) => {
      const stored = await tx.passwordResetToken.findUnique({
        where: { tokenHash },
      });

      if (!stored || stored.usedAt !== null || stored.expiresAt <= new Date()) {
        throw new BadRequestException('Link inválido ou expirado.');
      }

      const passwordHash = await argon2.hash(newPassword, {
        type: argon2.argon2id,
      });

      await tx.user.update({
        where: { id: stored.userId },
        data: { passwordHash },
      });

      await tx.passwordResetToken.update({
        where: { id: stored.id },
        data: { usedAt: new Date() },
      });

      return stored.userId;
    });

    // D-05: revoke every refresh token for this user after the password
    // change has committed — reuses the existing atomic updateMany.
    await this.authService.logout(userId);
  }

  private buildPasswordResetEmailHtml(params: { resetLink: string }): string {
    return `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; background: #EFE8DA; padding: 24px;">
  <div style="max-width: 480px; margin: 0 auto; background: #FAF7F0; border-radius: 20px; padding: 28px; box-shadow: 0 18px 40px -22px rgba(11,59,34,.42);">
    <div style="text-align: center; margin-bottom: 20px;">
      <h1 style="font-family: 'Baloo 2', sans-serif; color: #0B3B22; margin: 8px 0 4px;">Recuperar senha</h1>
      <p style="color: #5C6B61; font-size: 14px;">Alguém (esperamos que você) pediu pra trocar a senha da sua conta no Bora.</p>
    </div>
    <a href="${params.resetLink}" style="display: block; background: #2BD86B; color: #0B3B22; text-decoration: none; padding: 14px 22px; border-radius: 16px; text-align: center; font-weight: 700; font-size: 16px; margin-bottom: 16px;">
      Criar nova senha
    </a>
    <p style="font-size: 13px; color: #5C6B61; text-align: center;">Se não foi você, ignore este e-mail — sua senha continua a mesma. Este link expira em 1 hora.</p>
    <div style="margin-top: 20px; background: #16241C; color: #FAF7F0; border-radius: 14px; padding: 14px 16px; font-size: 12px; line-height: 1.5;">
      O <strong style="color: #2BD86B;">Bora</strong> é uma plataforma de gerenciamento de desafios de hábito entre amigos.
    </div>
  </div>
</body>
</html>`;
  }
}
