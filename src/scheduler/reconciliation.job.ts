import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentNotFoundError } from '../payments/errors/payment-not-found.error';
import { IPaymentProvider } from '../payments/interfaces/payment-provider.interface';
import { PaymentsService } from '../payments/payments.service';
import { describeError } from '../payments/utils/describe-error.util';

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
 *
 * FAULT ISOLATION (#2, 30/07/2026). This sweep used to have no error handling
 * at all, so the FIRST row the provider rejected threw straight out of the
 * loop and aborted the entire run — every later row went unreconciled and the
 * completion line never printed. Production showed the hourly
 * `[Scheduler] ERROR ... 'Payment not found'` and, tellingly, ZERO
 * `reconciliation: found=... updated=...` lines all day: the job had never
 * once finished. One unreconcilable payment must never cost the sweep the
 * other payments, so every item is now isolated and the run always reports.
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
    let failed = 0;

    for (const p of stale) {
      if (!p.externalId) {
        continue;
      }

      // Per-item isolation. The try wraps the WHOLE item, not just the
      // provider lookup: handleWebhook and the Prisma write can throw too, and
      // the property we need is "one bad row never aborts the sweep",
      // regardless of WHICH step went bad.
      try {
        if (await this.reconcileOne(p.id, p.externalId)) {
          updated++;
        }
      } catch (err) {
        // Transient (5xx, timeout, DB blip) — deliberately left PENDING so the
        // next hourly run tries again. Nothing is settled on a failure we do
        // not understand; on the money path, guessing is worse than waiting.
        failed++;
        this.logger.error(
          `reconciliation: skipped payment ${p.id} (external=${p.externalId}) — ${describeError(err)}`,
        );
      }
    }

    // Always reached now, even when every single item failed. Its absence in
    // the logs is what proved the job was dying mid-sweep, so it doubles as
    // the liveness signal for this cron.
    this.logger.log(
      `reconciliation: found=${stale.length} updated=${updated} failed=${failed} at=${new Date().toISOString()}`,
    );
  }

  /**
   * Reconcile one stale Payment. Returns true when this call changed state.
   *
   * Throws on any TRANSIENT provider/database failure — the caller catches,
   * counts, and moves on to the next row.
   */
  private async reconcileOne(paymentId: string, externalId: string): Promise<boolean> {
    let confirmed: { status: string; externalReference: string | null };

    try {
      confirmed = await this.psp.getPayment(externalId);
    } catch (err) {
      if (!(err instanceof PaymentNotFoundError)) {
        // Transient / unclassified: hand it to the caller's catch. Crucially
        // NOT cancelled — a provider that is merely down must not cost a payer
        // their charge.
        throw err;
      }

      // PERMANENT: the provider positively denies this id, so no number of
      // future runs will ever resolve it. Left PENDING it would be re-fetched,
      // re-throw, and (before per-item isolation) re-kill the sweep every hour
      // — a single orphan row silently disabling reconciliation for everyone.
      // CANCELLED is the honest local terminal state: it never collected money
      // (an approved charge is one the provider knows about), and it removes
      // the row from this query permanently.
      this.logger.warn(
        `reconciliation: payment ${paymentId} (external=${externalId}) is unknown to the provider — marking CANCELLED so it leaves the sweep (${err.providerDetail ?? 'no detail'})`,
      );

      await this.prisma.payment.update({
        where: { id: paymentId },
        data: { status: 'CANCELLED' },
      });

      return true;
    }

    if (confirmed.status === 'pending') {
      // Still genuinely pending at Mercado Pago — leave it, re-check next run.
      return false;
    }

    if (confirmed.status === 'approved') {
      // Mirror the webhook path exactly: handleWebhook is idempotent and
      // itself performs verify-via-API, marks the Payment APPROVED + the
      // Participant PAID + paidAt, and runs the atomic conditional
      // activation (tryActivateChallenge) if >=3 are now paid.
      await this.paymentsService.handleWebhook(externalId, {
        reconciled: true,
        reconciledAt: new Date().toISOString(),
      });
      return true;
    }

    // Any other terminal, non-approved status (cancelled/rejected/expired/etc.)
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'CANCELLED' },
    });
    return true;
  }
}
