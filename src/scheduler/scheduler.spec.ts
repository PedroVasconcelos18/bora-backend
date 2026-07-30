import { Test } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { ReconciliationJob } from './reconciliation.job';
import { DeadlineCancelJob } from './deadline-cancel.job';
import { VoteCloseJob } from './vote-close.job';
import { EvidenceReminderJob } from './evidence-reminder.job';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { VotingService } from '../voting/voting.service';
import { IPaymentProvider } from '../payments/interfaces/payment-provider.interface';
import { PaymentNotFoundError } from '../payments/errors/payment-not-found.error';
import { NotificationsListener } from '../notifications/notifications.listener';
import { NotificationsService } from '../notifications/notifications.service';
import { saoPauloDay } from '../common/utils/sao-paulo-day.util';

describe('ReconciliationJob (PAY-04, D-16)', () => {
  let job: ReconciliationJob;
  let psp: jest.Mocked<IPaymentProvider>;
  let paymentsService: { handleWebhook: jest.Mock };
  let prisma: { payment: { findMany: jest.Mock; update: jest.Mock } };

  const stalePending = {
    id: 'payment-1',
    externalId: 'mp-ext-1',
    status: 'PENDING',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
  };

  beforeEach(async () => {
    psp = {
      createPixCharge: jest.fn(),
      getPayment: jest.fn(),
    };

    paymentsService = {
      handleWebhook: jest.fn().mockResolvedValue({ activated: false }),
    };

    prisma = {
      payment: {
        findMany: jest.fn().mockResolvedValue([stalePending]),
        update: jest.fn(),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReconciliationJob,
        { provide: PrismaService, useValue: prisma },
        { provide: 'PAYMENT_PROVIDER', useValue: psp },
        { provide: PaymentsService, useValue: paymentsService },
      ],
    }).compile();

    job = moduleRef.get(ReconciliationJob);
  });

  it('finds stale PENDING payments older than the threshold and calls psp.getPayment for each', async () => {
    psp.getPayment.mockResolvedValue({ status: 'pending', externalReference: null });

    await job.run();

    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
    expect(psp.getPayment).toHaveBeenCalledWith('mp-ext-1');
  });

  it('mirrors the webhook path (delegates to handleWebhook) when the provider reports approved — a reconciled approval still activates', async () => {
    psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-1' });

    await job.run();

    expect(paymentsService.handleWebhook).toHaveBeenCalledWith('mp-ext-1', expect.any(Object));
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  it('updates the local Payment to CANCELLED for a terminal non-approved provider status', async () => {
    psp.getPayment.mockResolvedValue({ status: 'cancelled', externalReference: null });

    await job.run();

    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 'payment-1' },
      data: { status: 'CANCELLED' },
    });
    expect(paymentsService.handleWebhook).not.toHaveBeenCalled();
  });

  it('leaves a genuinely still-pending charge untouched (no-op)', async () => {
    psp.getPayment.mockResolvedValue({ status: 'pending', externalReference: null });

    await job.run();

    expect(paymentsService.handleWebhook).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  it('is idempotent: running twice leaves exactly one reconciliation once the payment has moved off PENDING', async () => {
    psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-1' });

    await job.run();
    expect(paymentsService.handleWebhook).toHaveBeenCalledTimes(1);

    // Second run: the payment moved off PENDING, so the `status: 'PENDING'`
    // query no longer returns it — mirrors real DB behavior after the first
    // run's handleWebhook call flips the row to APPROVED.
    prisma.payment.findMany.mockResolvedValueOnce([]);
    await job.run();

    expect(paymentsService.handleWebhook).toHaveBeenCalledTimes(1);
  });

  /**
   * #2 — fault isolation.
   *
   * Production, 30/07/2026: `[Scheduler] ERROR ... 'Payment not found'` every
   * hour and NOT ONE `reconciliation: found=...` line all day. The sweep had
   * no error handling, so the first orphan row threw out of the loop and the
   * job never completed — one dead row disabling reconciliation for every
   * other payment in the system.
   *
   * The ordering in these tests is deliberate: the failing row comes FIRST,
   * because a fix that only survives a failure on the LAST item proves
   * nothing.
   */
  describe('#2 — one bad row must never abort the sweep', () => {
    const orphan = {
      id: 'payment-orphan',
      externalId: 'mp-ext-orphan',
      status: 'PENDING',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    };
    const healthy = {
      id: 'payment-healthy',
      externalId: 'mp-ext-healthy',
      status: 'PENDING',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    };

    /** Orphan first, healthy second. */
    const bothRows = () => prisma.payment.findMany.mockResolvedValue([orphan, healthy]);

    it('processes BOTH rows and completes when the FIRST one 404s at the provider', async () => {
      bothRows();
      const logSpy = jest.spyOn(job['logger'], 'log');
      psp.getPayment.mockImplementation(async (externalId: string) => {
        if (externalId === 'mp-ext-orphan') {
          throw new PaymentNotFoundError(externalId, 'not_found code 2000');
        }
        return { status: 'approved', externalReference: 'participant-1' };
      });

      await job.run();

      // Both were visited — the loop did not stop at the orphan.
      expect(psp.getPayment).toHaveBeenCalledWith('mp-ext-orphan');
      expect(psp.getPayment).toHaveBeenCalledWith('mp-ext-healthy');
      // And the healthy one was actually reconciled, not merely visited.
      expect(paymentsService.handleWebhook).toHaveBeenCalledWith('mp-ext-healthy', expect.any(Object));
      // The orphan was settled, not just skipped.
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'payment-orphan' },
        data: { status: 'CANCELLED' },
      });
      // ...and the run REACHED THE END. Asserting the completion line matters
      // as much as the two assertions above: production's tell was not an
      // error in the log, it was the absence of this line.
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('reconciliation: found=2 updated=2 failed=0'),
      );
    });

    it('marks a 404 row CANCELLED so it permanently leaves the PENDING scan', async () => {
      prisma.payment.findMany.mockResolvedValue([orphan]);
      psp.getPayment.mockRejectedValue(new PaymentNotFoundError('mp-ext-orphan', 'detail'));

      await job.run();

      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'payment-orphan' },
        data: { status: 'CANCELLED' },
      });
      // An id the provider disowns never collected money — it must not be
      // replayed through the approval path.
      expect(paymentsService.handleWebhook).not.toHaveBeenCalled();
    });

    it('always emits the completion line — even when EVERY item fails', async () => {
      bothRows();
      const logSpy = jest.spyOn(job['logger'], 'log');
      psp.getPayment.mockRejectedValue(new Error('provider unreachable'));

      await job.run();

      // The absence of this line in production was the evidence the job was
      // dying mid-sweep, so it doubles as this cron's liveness signal.
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('reconciliation: found=2'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('failed=2'));
    });

    it('a TRANSIENT failure (5xx/timeout) leaves the row PENDING — never cancelled — so the next run retries it', async () => {
      prisma.payment.findMany.mockResolvedValue([orphan]);
      psp.getPayment.mockRejectedValue(new Error('socket hang up'));

      await job.run();

      // The critical asymmetry: a provider that is merely DOWN must not cost
      // a payer their charge. Only a positive "I do not have it" cancels.
      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(paymentsService.handleWebhook).not.toHaveBeenCalled();
    });

    it('survives a failure in the WRITE path too, not just the provider lookup', async () => {
      bothRows();
      psp.getPayment.mockResolvedValue({ status: 'cancelled', externalReference: null });
      prisma.payment.update
        .mockRejectedValueOnce(new Error('deadlock detected'))
        .mockResolvedValue({});

      await job.run();

      // Isolation wraps the whole item, not just getPayment: the second row is
      // still written even though the first row's UPDATE blew up.
      expect(prisma.payment.update).toHaveBeenCalledTimes(2);
      expect(prisma.payment.update).toHaveBeenLastCalledWith({
        where: { id: 'payment-healthy' },
        data: { status: 'CANCELLED' },
      });
    });

    it('survives a failure inside handleWebhook on the approved path', async () => {
      bothRows();
      psp.getPayment.mockResolvedValue({ status: 'approved', externalReference: 'participant-1' });
      paymentsService.handleWebhook
        .mockRejectedValueOnce(new Error('challenge activation blew up'))
        .mockResolvedValue({ activated: false });

      await job.run();

      expect(paymentsService.handleWebhook).toHaveBeenCalledTimes(2);
      expect(paymentsService.handleWebhook).toHaveBeenLastCalledWith(
        'mp-ext-healthy',
        expect.any(Object),
      );
    });

    it('run() itself never rejects, whatever the items do — an unhandled rejection would kill the scheduler tick', async () => {
      bothRows();
      psp.getPayment.mockRejectedValue(new PaymentNotFoundError('x', 'y'));
      prisma.payment.update.mockRejectedValue(new Error('db down'));

      await expect(job.run()).resolves.toBeUndefined();
    });

    it('counts only rows it actually changed: 1 orphan cancelled + 1 still-pending = updated=1', async () => {
      bothRows();
      const logSpy = jest.spyOn(job['logger'], 'log');
      psp.getPayment.mockImplementation(async (externalId: string) => {
        if (externalId === 'mp-ext-orphan') {
          throw new PaymentNotFoundError(externalId, 'detail');
        }
        return { status: 'pending', externalReference: null };
      });

      await job.run();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('found=2 updated=1 failed=0'),
      );
    });
  });
});

describe('DeadlineCancelJob (D-02/D-07/D-09, CHAL-06 deadline path)', () => {
  let job: DeadlineCancelJob;
  let paymentsService: { processDeadline: jest.Mock; activateIfDue: jest.Mock };
  let prisma: { challenge: { findMany: jest.Mock } };

  const expiredChallenge = { id: 'challenge-1' };

  beforeEach(async () => {
    paymentsService = {
      processDeadline: jest.fn(),
      // Data de início (feedback): sweep extra de desafios cuja `starts_at` já
      // chegou. Sem candidatos due por padrão para não poluir as asserções de
      // processDeadline; o teste dedicado abaixo cobre o caminho de ativação.
      activateIfDue: jest.fn().mockResolvedValue({ action: 'none' }),
    };

    prisma = {
      challenge: {
        // 1ª chamada = sweep de expirados (3 dias); 2ª = sweep de data de
        // início. Default: expirados retorna o challenge, due retorna vazio.
        findMany: jest
          .fn()
          .mockResolvedValueOnce([expiredChallenge])
          .mockResolvedValue([]),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        DeadlineCancelJob,
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentsService, useValue: paymentsService },
      ],
    }).compile();

    job = moduleRef.get(DeadlineCancelJob);
  });

  it('finds WAITING challenges past the 3-day deadline and delegates each to processDeadline', async () => {
    paymentsService.processDeadline.mockResolvedValue({ action: 'activated' });

    await job.run();

    expect(prisma.challenge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'WAITING' }),
      }),
    );
    expect(paymentsService.processDeadline).toHaveBeenCalledWith('challenge-1');
  });

  it('activates a WAITING challenge with >=3 paid (processDeadline reports activated)', async () => {
    paymentsService.processDeadline.mockResolvedValue({ action: 'activated' });

    await job.run();

    expect(paymentsService.processDeadline).toHaveBeenCalledTimes(1);
  });

  it('cancels a WAITING challenge with <3 paid into the refund queue (processDeadline reports cancelled)', async () => {
    paymentsService.processDeadline.mockResolvedValue({ action: 'cancelled' });

    await job.run();

    expect(paymentsService.processDeadline).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a second run finds nothing once the challenge is no longer WAITING', async () => {
    paymentsService.processDeadline.mockResolvedValue({ action: 'cancelled' });

    await job.run();
    expect(paymentsService.processDeadline).toHaveBeenCalledTimes(1);

    // Second run: the challenge resolved (no longer WAITING), so the
    // `status: 'WAITING'` query stops returning it.
    prisma.challenge.findMany.mockResolvedValueOnce([]);
    await job.run();

    expect(paymentsService.processDeadline).toHaveBeenCalledTimes(1);
  });

  it('activates challenges whose planned start date has arrived via activateIfDue (data de início, feedback)', async () => {
    // No expired challenges; one whose starts_at is due.
    prisma.challenge.findMany
      .mockReset()
      .mockResolvedValueOnce([]) // expired sweep
      .mockResolvedValueOnce([{ id: 'challenge-due' }]); // due sweep
    paymentsService.activateIfDue.mockResolvedValue({ action: 'activated' });

    await job.run();

    expect(paymentsService.processDeadline).not.toHaveBeenCalled();
    expect(paymentsService.activateIfDue).toHaveBeenCalledWith('challenge-due');
    // The due sweep queries WAITING challenges whose starts_at has passed.
    expect(prisma.challenge.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'WAITING',
          startsAt: expect.objectContaining({ lte: expect.any(Date) }),
        }),
      }),
    );
  });
});

describe('VoteCloseJob (VOTE-05)', () => {
  let job: VoteCloseJob;
  let votingService: { resolveEvidence: jest.Mock };
  let prisma: { evidence: { findMany: jest.Mock } };

  const expiredEvidences = [{ id: 'evidence-1' }, { id: 'evidence-2' }];

  beforeEach(async () => {
    votingService = { resolveEvidence: jest.fn() };

    prisma = {
      evidence: {
        findMany: jest.fn().mockResolvedValue(expiredEvidences),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VoteCloseJob,
        { provide: PrismaService, useValue: prisma },
        { provide: VotingService, useValue: votingService },
      ],
    }).compile();

    job = moduleRef.get(VoteCloseJob);
  });

  it('finds PENDING evidences past their 24h window and delegates each to resolveEvidence', async () => {
    votingService.resolveEvidence.mockResolvedValue('accepted');

    await job.run();

    expect(prisma.evidence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
    expect(votingService.resolveEvidence).toHaveBeenCalledWith('evidence-1');
    expect(votingService.resolveEvidence).toHaveBeenCalledWith('evidence-2');
    expect(votingService.resolveEvidence).toHaveBeenCalledTimes(2);
  });

  it('aggregates accepted/rejected counts from resolveEvidence results', async () => {
    votingService.resolveEvidence
      .mockResolvedValueOnce('accepted')
      .mockResolvedValueOnce('rejected');

    await job.run();

    expect(votingService.resolveEvidence).toHaveBeenCalledTimes(2);
  });

  it('is idempotent: a second run resolves nothing new once the evidence is no longer PENDING', async () => {
    votingService.resolveEvidence.mockResolvedValue('accepted');

    await job.run();
    expect(votingService.resolveEvidence).toHaveBeenCalledTimes(2);

    // Second run: both evidences resolved (no longer PENDING), so the
    // `status: 'PENDING'` query stops returning them.
    prisma.evidence.findMany.mockResolvedValueOnce([]);
    await job.run();

    expect(votingService.resolveEvidence).toHaveBeenCalledTimes(2);
  });

  it('performs no new resolution when resolveEvidence itself reports already-resolved', async () => {
    prisma.evidence.findMany.mockResolvedValueOnce([{ id: 'evidence-1' }]);
    votingService.resolveEvidence.mockResolvedValueOnce('already-resolved');

    await job.run();

    expect(votingService.resolveEvidence).toHaveBeenCalledTimes(1);
    expect(votingService.resolveEvidence).toHaveBeenCalledWith('evidence-1');
  });
});

describe('EvidenceReminderJob (NOTIF-02 tipo 5, D-07 — the 5th cron)', () => {
  let job: EvidenceReminderJob;
  let eventEmitter: { emit: jest.Mock };
  let prisma: { participant: { findMany: jest.Mock } };

  const today = saoPauloDay();

  const missingCandidate = {
    id: 'participant-1',
    userId: 'user-1',
    challengeId: 'challenge-1',
  };

  beforeEach(async () => {
    eventEmitter = { emit: jest.fn() };

    prisma = {
      participant: {
        findMany: jest.fn().mockResolvedValue([missingCandidate]),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        EvidenceReminderJob,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    job = moduleRef.get(EvidenceReminderJob);
  });

  it('queries PAID/ACTIVE participants of ACTIVE challenges with no evidence posted today', async () => {
    await job.run();

    expect(prisma.participant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['PAID', 'ACTIVE'] },
          challenge: { status: 'ACTIVE' },
          evidences: { none: { evidenceDate: today } },
        }),
      }),
    );
  });

  it('emits exactly one evidence.reminder event per candidate found', async () => {
    prisma.participant.findMany.mockResolvedValueOnce([
      missingCandidate,
      { id: 'participant-2', userId: 'user-2', challengeId: 'challenge-2' },
    ]);

    await job.run();

    expect(eventEmitter.emit).toHaveBeenCalledTimes(2);
    expect(eventEmitter.emit).toHaveBeenCalledWith('evidence.reminder', {
      participantId: 'participant-1',
      userId: 'user-1',
      challengeId: 'challenge-1',
      evidenceDate: today,
    });
  });

  it('with zero candidates, emits nothing and still logs a summary', async () => {
    prisma.participant.findMany.mockResolvedValueOnce([]);
    const logSpy = jest.spyOn(job['logger'], 'log');

    await job.run();

    expect(eventEmitter.emit).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('found=0'));
  });
});

describe('NotificationsListener error isolation (T-09-06, D-02/D-03, property V2)', () => {
  /**
   * Proves the property the whole phase's Denial-of-Service mitigation rests
   * on: a real EventEmitterModule + a real NotificationsListener, wired to a
   * NotificationsService whose createMany/create REJECT — and asserts the
   * emit() call that triggered it still resolves normally. This is what
   * makes `emit()` (never the awaited-dispatch variant) + the library's
   * default suppressErrors=true a correctness guarantee, not just a
   * convention: a bug in the listener can never propagate back into the
   * payment/voting/finalization flow that emitted the event.
   */
  it('emit() resolves without throwing even when the listener throws inside every handler', async () => {
    const prisma = {
      challenge: { findUnique: jest.fn().mockResolvedValue({ title: 'Corrida' }) },
      participant: {
        findUnique: jest.fn().mockResolvedValue({ user: { name: 'Ana' } }),
        findMany: jest.fn().mockResolvedValue([{ id: 'participant-1', userId: 'user-1' }]),
      },
      user: { findUnique: jest.fn() },
      evidence: { findUnique: jest.fn(), count: jest.fn() },
    };

    const notifications = {
      create: jest.fn().mockRejectedValue(new Error('boom — NotificationsService is down')),
      createMany: jest.fn().mockRejectedValue(new Error('boom — NotificationsService is down')),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        NotificationsListener,
        { provide: NotificationsService, useValue: notifications },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    await moduleRef.init(); // required for EventSubscribersLoader to register @OnEvent handlers

    const eventEmitter = moduleRef.get(EventEmitter2);

    // emit() is synchronous dispatch and must never throw or reject, even
    // though every downstream handler this event reaches will reject.
    expect(() =>
      eventEmitter.emit('challenge.activated', { challengeId: 'challenge-1' }),
    ).not.toThrow();

    // Give the listener's rejected promise a microtask tick to settle —
    // asserting the test process is still alive (no unhandled rejection
    // crash) is the point of this test, not any particular return value.
    await new Promise((resolve) => setImmediate(resolve));

    expect(notifications.createMany).toHaveBeenCalled();
  });
});
