import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { IPaymentProvider } from '../payments/interfaces/payment-provider.interface';
import { PaymentsService } from '../payments/payments.service';

// PAY-04 / D-16: a webhook that never arrives must not leave a charge in
// limbo forever. 2 hours is comfortably longer than the 30-min Pix QR expiry
// (D-08), so a genuinely-still-pending charge is left alone on this pass.
const STALE_PENDING_THRESHOLD_MS = 2 * 60 * 60 * 1000;

/**
 * Reconciliation cron (PAY-04, D-16, pitfall T1).
 *
 * Sweeps `Payment` rows stuck in PENDING whose webhook never arrived and
 * confirms their real status via `GET /v1/payments/{id}` (verify-via-API —
 * never trusts anything but the provider's own answer, same rule as the
 * webhook handler, D-15). An `approved` reconciliation mirrors the webhook
 * path exactly by delegating to `PaymentsService.handleWebhook` — the same
 * idempotent, `@unique(externalId)`-keyed entry point — so a reconciled
 * approval still marks the participant PAID and (if >=3 paid) activates the
 * challenge, with zero duplicated state-transition logic. Any other terminal
 * provider status (cancelled/rejected/expired) is recorded locally as
 * CANCELLED so this same query stops picking it up on the next run.
 *
 * Idempotent: once a Payment moves off PENDING, the `where: { status:
 * 'PENDING' }` query simply stops returning it — running this job twice in
 * a row (or twice concurrently) produces the same end state.
 */
@Injectable()
export class ReconciliationJob {
  private readonly logger = new Logger(ReconciliationJob.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject('PAYMENT_PROVIDER') private readonly psp: IPaymentProvider,
    private readonly paymentsService: PaymentsService,
  ) {}

  @Cron('0 * * * *', { timeZone: 'America/Sao_Paulo' }) // hourly, timezone-aware (D-16)
  async run(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_PENDING_THRESHOLD_MS);

    const stale = await this.prisma.payment.findMany({
      where: {
        status: 'PENDING',
        externalId: { not: null },
        createdAt: { lt: cutoff },
      },
    });

    let updated = 0;

    for (const p of stale) {
      if (!p.externalId) {
        continue;
      }

      const confirmed = await this.psp.getPayment(p.externalId);

      if (confirmed.status === 'pending') {
        // Still genuinely pending at Mercado Pago — leave it, re-check next run.
        continue;
      }

      if (confirmed.status === 'approved') {
        // Mirror the webhook path exactly: handleWebhook is idempotent and
        // itself performs verify-via-API, marks the Payment APPROVED + the
        // Participant PAID + paidAt, and runs the atomic conditional
        // activation (tryActivateChallenge) if >=3 are now paid.
        await this.paymentsService.handleWebhook(p.externalId, {
          reconciled: true,
          reconciledAt: new Date().toISOString(),
        });
        updated++;
        continue;
      }

      // Any other terminal, non-approved status (cancelled/rejected/expired/etc.)
      await this.prisma.payment.update({
        where: { id: p.id },
        data: { status: 'CANCELLED' },
      });
      updated++;
    }

    this.logger.log(
      `reconciliation: found=${stale.length} updated=${updated} at=${new Date().toISOString()}`,
    );
  }
}
