import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ParticipantsService } from './participants.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';

describe('ParticipantsService.getWaitingRoomStatus', () => {
  let service: ParticipantsService;
  let prisma: { challenge: { findUnique: jest.Mock } };

  const createdAt = new Date('2026-07-01T00:00:00.000Z');

  const challengeWithParticipants = {
    id: 'challenge-1',
    status: 'WAITING',
    createdAt,
    collabAmount: 50 as unknown as number,
    platformFee: 10 as unknown as number,
    participants: [
      { status: 'PAID', paidAt: new Date('2026-07-02T00:00:00.000Z'), user: { name: 'Ana' } },
      { status: 'PAID', paidAt: new Date('2026-07-01T12:00:00.000Z'), user: { name: 'Bia' } },
      { status: 'INVITED', paidAt: null, user: { name: 'Caio' } },
    ],
  };

  beforeEach(async () => {
    prisma = {
      challenge: {
        findUnique: jest.fn().mockResolvedValue(challengeWithParticipants),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ParticipantsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentsService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(ParticipantsService);
  });

  it('computes the live prize from the paid count on every read (D-03, pitfall M4) — never a cached value', async () => {
    const result = await service.getWaitingRoomStatus('challenge-1');

    // 2 paid * 50 collabAmount - 10 platformFee = 90
    expect(result.prize).toBe('90.00');
    expect(result.paidCount).toBe(2);
    expect(result.totalCount).toBe(3);
  });

  it('returns a nominal name/paid list visible for every participant (D-13), never just a count', async () => {
    const result = await service.getWaitingRoomStatus('challenge-1');

    expect(result.participants).toEqual([
      { name: 'Ana', paid: true },
      { name: 'Bia', paid: true },
      { name: 'Caio', paid: false },
    ]);
  });

  it('computes the deadline as createdAt + 3 days (D-07)', async () => {
    const result = await service.getWaitingRoomStatus('challenge-1');

    expect(result.deadline.toISOString()).toBe('2026-07-04T00:00:00.000Z');
  });

  it('clamps the prize at 0 rather than showing a negative value when nobody has paid yet', async () => {
    prisma.challenge.findUnique.mockResolvedValueOnce({
      ...challengeWithParticipants,
      participants: challengeWithParticipants.participants.map((p) => ({
        ...p,
        status: 'INVITED',
      })),
    });

    const result = await service.getWaitingRoomStatus('challenge-1');

    expect(result.prize).toBe('0.00');
  });

  it('throws NotFoundException for an unknown challenge', async () => {
    prisma.challenge.findUnique.mockResolvedValueOnce(null);

    await expect(service.getWaitingRoomStatus('missing')).rejects.toThrow(NotFoundException);
  });
});
