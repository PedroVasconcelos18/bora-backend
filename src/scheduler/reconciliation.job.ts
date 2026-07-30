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
 * Circuit breaker for a MASS not-found sweep (review hardening, 30/07/2026).
 *
 * One row the provider disowns is an orphan: expected, and cancelling it is the
 * whole point of #2. EVERY row 404ing in a single run is a categorically
 * different event — the shape of a credential fault (wrong/expired token, token
 * pointing at another Mercado Pago account), where every charge is alive and
 * ours. Both used to produce the same irreversible action, just N times.
 *
 * Trip condition requires BOTH:
 *   - at least MIN_ROWS orphans in absolute terms, and
 *   - orphans making up at least FRACTION of the sweep.
 *
 * Why both. On a sweep of one row, a fraction test alone always reads 100% and
 * would block the single-orphan cancel that #2 exists to perform — so an
 * absolute floor is needed. On a large sweep, an absolute test alone would trip
 * on a handful of genuinely dead rows — so a fraction is needed.
 *
 * Why 5 and 0.5 specifically. The incident that motivated all of this produced
 * FOUR orphan rows for one participant (30/07/2026), and this app's realistic
 * orphan count is single-digit; a floor of 5 keeps the breaker from firing on
 * the shape of the known incident. A credential fault, by contrast, cannot
 * produce a minority — every live charge answers the same way, so any majority
 * of 404s in a multi-row sweep is already the systemic shape.
 */
const MASS_NOT_FOUND_MIN_ROWS = 5;
const MASS_NOT_FOUND_FRACTION = 0.5;

/** What one row's provider lookup concluded. Cancels are applied separately. */
type ReconcileOutcome =
  | { kind: 'unchanged' }
  | { kind: 'settled' }
  | { kind: 'not-found'; detail?: string };

interface Orphan {
  paymentId: string;
  externalId: string;
  detail?: string;
}

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
 *
 * TWO PASSES (review hardening, 30/07/2026). Classification (which needs the
 * provider) is separated from the CANCEL writes (which destroy money state)
 * precisely so the second pass can look at the whole run before acting — a
 * decision that is impossible while cancelling inline, row by row. Crediting is
 * NOT deferred: replaying an `approved` through handleWebhook is idempotent and
 * only ever moves money toward its owner, so it stays in pass one.
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
    const orphans: Orphan[] = [];

    for (const p of stale) {
      if (!p.externalId) {
        continue;
      }

      // Per-item isolation. The try wraps the WHOLE item, not just the
      // provider lookup: handleWebhook and the Prisma write can throw too, and
      // the property we need is "one bad row never aborts the sweep",
      // regardless of WHICH step went bad.
      try {
        const outcome = await this.reconcileOne(p.id, p.externalId);

        if (outcome.kind === 'settled') {
          updated++;
        } else if (outcome.kind === 'not-found') {
          // NOT cancelled here — collected, and decided on in pass two once the
          // shape of the whole sweep is known.
          orphans.push({ paymentId: p.id, externalId: p.externalId, detail: outcome.detail });
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

    const orphanResult = await this.settleOrphans(orphans, stale.length);
    updated += orphanResult.cancelled;
    failed += orphanResult.failed;

    // Always reached now, even when every single item failed. Its absence in
    // the logs is what proved the job was dying mid-sweep, so it doubles as
    // the liveness signal for this cron.
    this.logger.log(
      `reconciliation: found=${stale.length} updated=${updated} failed=${failed} at=${new Date().toISOString()}`,
    );
  }

  /**
   * PASS TWO — cancel the rows the provider disowned, unless the sweep as a
   * whole looks like a credential fault rather than a set of orphans.
   *
   * Returns what actually happened, so the completion line stays truthful.
   */
  private async settleOrphans(
    orphans: Orphan[],
    sweepSize: number,
  ): Promise<{ cancelled: number; failed: number }> {
    if (orphans.length === 0) {
      return { cancelled: 0, failed: 0 };
    }

    if (this.isMassNotFound(orphans.length, sweepSize)) {
      // Deliberately cancels NOTHING and settles nothing. The rows stay
      // PENDING, so the next hourly run re-evaluates them for free — and if
      // this really was a bad token, they are all still here, intact, once it
      // is fixed. The old behavior (cancel each one) was unrecoverable.
      this.logger.error(
        `reconciliation: CIRCUIT BREAKER — ${orphans.length} of ${sweepSize} swept payments are unknown to the provider. ` +
          'That is the shape of a credential/account fault, not of orphan rows, so NOTHING was cancelled this run. ' +
          `Check MERCADOPAGO_ACCESS_TOKEN (account and test/live prefix). Affected externals: ${orphans
            .map((o) => o.externalId)
            .join(', ')}`,
      );
      return { cancelled: 0, failed: 0 };
    }

    let cancelled = 0;
    let failed = 0;

    for (const orphan of orphans) {
      try {
        // PERMANENT: the provider positively denies this id, so no number of
        // future runs will ever resolve it. Left PENDING it would be
        // re-fetched, re-throw, and (before per-item isolation) re-kill the
        // sweep every hour — a single orphan row silently disabling
        // reconciliation for everyone. CANCELLED is the honest local terminal
        // state: it never collected money (an approved charge is one the
        // provider knows about), and it removes the row from this query.
        this.logger.warn(
          `reconciliation: payment ${orphan.paymentId} (external=${orphan.externalId}) is unknown to the provider — marking CANCELLED so it leaves the sweep (${orphan.detail ?? 'no detail'})`,
        );

        if (await this.cancelIfStillPending(orphan.paymentId)) {
          cancelled++;
        }
      } catch (err) {
        failed++;
        this.logger.error(
          `reconciliation: could not cancel payment ${orphan.paymentId} (external=${orphan.externalId}) — ${describeError(err)}`,
        );
      }
    }

    return { cancelled, failed };
  }

  /** Is this sweep's not-found count the shape of a systemic fault? */
  private isMassNotFound(notFoundCount: number, sweepSize: number): boolean {
    return (
      notFoundCount >= MASS_NOT_FOUND_MIN_ROWS &&
      notFoundCount >= sweepSize * MASS_NOT_FOUND_FRACTION
    );
  }

  /**
   * CANCELLED, but only while the row is still PENDING.
   *
   * `updateMany` with a status predicate rather than `update` by id (review
   * hardening, 30/07/2026): the read that selected this row and this write are
   * separated by an HTTP call with a 5s timeout, and a webhook landing inside
   * that window sets the payment APPROVED and the participant PAID. An
   * unconditional update would then overwrite it to CANCELLED, producing a PAID
   * participant whose payment is CANCELLED — invisible to the refund queue
   * (which keys on REFUND_PENDING) and to this sweep alike. The predicate makes
   * the write lose that race instead of winning it.
   *
   * Returns whether this call actually changed anything.
   */
  private async cancelIfStillPending(paymentId: string): Promise<boolean> {
    const result = await this.prisma.payment.updateMany({
      where: { id: paymentId, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });

    if (result.count === 0) {
      this.logger.warn(
        `reconciliation: payment ${paymentId} left PENDING while we were asking the provider — leaving its new status alone (not overwritten with CANCELLED)`,
      );
      return false;
    }

    return true;
  }

  /**
   * Ask the provider about one stale Payment and classify the answer.
   *
   * Performs the SAFE writes inline (replaying an approval, settling a
   * positively-terminal status) and reports a not-found for pass two to decide
   * on. Throws on any TRANSIENT provider/database failure — the caller catches,
   * counts, and moves on to the next row.
   */
  private async reconcileOne(paymentId: string, externalId: string): Promise<ReconcileOutcome> {
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

      return { kind: 'not-found', detail: err.providerDetail };
    }

    if (confirmed.status === 'pending') {
      // Still genuinely pending at Mercado Pago — leave it, re-check next run.
      return { kind: 'unchanged' };
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
      return { kind: 'settled' };
    }

    // Any other terminal, non-approved status (cancelled/rejected/expired/etc.)
    // — a POSITIVE answer from the provider, so it is not deferred to pass two;
    // it is not the credential-fault shape. Still conditional on PENDING for the
    // same race reason as above.
    return (await this.cancelIfStillPending(paymentId))
      ? { kind: 'settled' }
      : { kind: 'unchanged' };
  }
}
