import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AdminService (D-2/T-i98 pixKey fallback chain)', () => {
  let service: AdminService;
  let prisma: {
    payment: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      payment: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [AdminService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(AdminService);
  });

  describe('listRefunds', () => {
    it('resolves pixKey to participant.pixKey when present', async () => {
      prisma.payment.findMany.mockResolvedValueOnce([
        {
          id: 'payment-1',
          amount: '25.00',
          challenge: { title: 'Corrida' },
          participant: { pixKey: 'participant@pix', user: { name: 'João', pixKey: 'profile@pix' } },
        },
      ]);

      const result = await service.listRefunds();

      expect(result[0].pixKey).toBe('participant@pix');
    });

    it("falls back to the participant's user profile pixKey when participant.pixKey is null", async () => {
      prisma.payment.findMany.mockResolvedValueOnce([
        {
          id: 'payment-1',
          amount: '25.00',
          challenge: { title: 'Corrida' },
          participant: { pixKey: null, user: { name: 'João', pixKey: 'profile@pix' } },
        },
      ]);

      const result = await service.listRefunds();

      expect(result[0].pixKey).toBe('profile@pix');
    });

    it('resolves to null when neither participant.pixKey nor the profile key is set', async () => {
      prisma.payment.findMany.mockResolvedValueOnce([
        {
          id: 'payment-1',
          amount: '25.00',
          challenge: { title: 'Corrida' },
          participant: { pixKey: null, user: { name: 'João', pixKey: null } },
        },
      ]);

      const result = await service.listRefunds();

      expect(result[0].pixKey).toBeNull();
    });
  });

  describe('listPayouts', () => {
    it('resolves pixKey to the snapshotted payment.pixKey when present, ignoring live values', async () => {
      prisma.payment.findMany.mockResolvedValueOnce([
        {
          id: 'payment-1',
          amount: '50.00',
          pixKey: 'snapshot@pix',
          challenge: { title: 'Corrida' },
          participant: { pixKey: 'participant@pix', user: { name: 'Maria', pixKey: 'profile@pix' } },
        },
      ]);

      const result = await service.listPayouts();

      expect(result[0].pixKey).toBe('snapshot@pix');
    });

    it('falls back to participant.pixKey when the snapshot is null (older row)', async () => {
      prisma.payment.findMany.mockResolvedValueOnce([
        {
          id: 'payment-1',
          amount: '50.00',
          pixKey: null,
          challenge: { title: 'Corrida' },
          participant: { pixKey: 'participant@pix', user: { name: 'Maria', pixKey: 'profile@pix' } },
        },
      ]);

      const result = await service.listPayouts();

      expect(result[0].pixKey).toBe('participant@pix');
    });

    it("falls back to the participant's user profile pixKey when both the snapshot and participant.pixKey are null", async () => {
      prisma.payment.findMany.mockResolvedValueOnce([
        {
          id: 'payment-1',
          amount: '50.00',
          pixKey: null,
          challenge: { title: 'Corrida' },
          participant: { pixKey: null, user: { name: 'Maria', pixKey: 'profile@pix' } },
        },
      ]);

      const result = await service.listPayouts();

      expect(result[0].pixKey).toBe('profile@pix');
    });
  });

  describe('markRefunded', () => {
    it('throws NotFoundException when the payment does not exist', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(null);

      await expect(service.markRefunded('missing')).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when the payment is not REFUND_PENDING', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce({ id: 'payment-1', status: 'REFUNDED' });

      await expect(service.markRefunded('payment-1')).rejects.toThrow(ConflictException);
    });

    it('marks a REFUND_PENDING payment as REFUNDED', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce({ id: 'payment-1', status: 'REFUND_PENDING' });
      prisma.payment.update.mockResolvedValueOnce({ id: 'payment-1', status: 'REFUNDED' });

      const result = await service.markRefunded('payment-1');

      expect(result).toEqual({ id: 'payment-1', status: 'REFUNDED' });
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'payment-1' },
        data: { status: 'REFUNDED', refundedAt: expect.any(Date) },
      });
    });
  });

  describe('markPaidOut', () => {
    it('throws NotFoundException when the payment does not exist', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(null);

      await expect(service.markPaidOut('missing')).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when the payment is not PAYOUT_PENDING', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce({ id: 'payment-1', status: 'PAID_OUT' });

      await expect(service.markPaidOut('payment-1')).rejects.toThrow(ConflictException);
    });

    it('marks a PAYOUT_PENDING payment as PAID_OUT', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce({ id: 'payment-1', status: 'PAYOUT_PENDING' });
      prisma.payment.update.mockResolvedValueOnce({ id: 'payment-1', status: 'PAID_OUT' });

      const result = await service.markPaidOut('payment-1');

      expect(result).toEqual({ id: 'payment-1', status: 'PAID_OUT' });
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'payment-1' },
        data: { status: 'PAID_OUT', paidAt: expect.any(Date) },
      });
    });
  });
});
