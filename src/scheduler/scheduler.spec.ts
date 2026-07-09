import { Test } from '@nestjs/testing';
import { ReconciliationJob } from './reconciliation.job';
import { DeadlineCancelJob } from './deadline-cancel.job';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { IPaymentProvider } from '../payments/interfaces/payment-provider.interface';

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
});

describe('DeadlineCancelJob (D-02/D-07/D-09, CHAL-06 deadline path)', () => {
  let job: DeadlineCancelJob;
  let paymentsService: { processDeadline: jest.Mock };
  let prisma: { challenge: { findMany: jest.Mock } };

  const expiredChallenge = { id: 'challenge-1' };

  beforeEach(async () => {
    paymentsService = { processDeadline: jest.fn() };

    prisma = {
      challenge: {
        findMany: jest.fn().mockResolvedValue([expiredChallenge]),
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
});
