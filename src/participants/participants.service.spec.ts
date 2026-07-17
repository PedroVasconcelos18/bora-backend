import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ParticipantsService } from './participants.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';

describe('ParticipantsService.getWaitingRoomStatus', () => {
  let service: ParticipantsService;
  let prisma: { challenge: { findUnique: jest.Mock } };

  const createdAt = new Date('2026-07-01T00:00:00.000Z');

  // 3 accepted participants (2 PAID, 1 INVITED) + 2 still-pending invites =
  // expected turma of 5 (feedback QA 5b/5c: pending invites must count).
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
    invites: [
      { id: 'inv-1', targetEmail: 'duda@example.com' },
      { id: 'inv-2', targetEmail: 'edu@example.com' },
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

  it('counts the expected turma (participants + pending invites) for totalCount and the "se todo mundo pagar" prize (feedback QA 5b/5c)', async () => {
    const result = await service.getWaitingRoomStatus('challenge-1');

    // expected turma = 3 participants + 2 pending invites = 5
    // prize = 5 * 50 collabAmount - 10 platformFee = 240
    expect(result.prize).toBe('240.00');
    expect(result.totalCount).toBe(5);
    // paidCount still reflects who actually paid, not the expected turma
    expect(result.paidCount).toBe(2);
  });

  it('returns still-pending invites so the creator can edit/delete them (feedback QA 5a)', async () => {
    const result = await service.getWaitingRoomStatus('challenge-1');

    expect(result.pendingInvites).toEqual([
      { id: 'inv-1', email: 'duda@example.com' },
      { id: 'inv-2', email: 'edu@example.com' },
    ]);
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

  it('clamps the prize at 0 rather than showing a negative value when the expected pool is below the fee', async () => {
    prisma.challenge.findUnique.mockResolvedValueOnce({
      ...challengeWithParticipants,
      collabAmount: 5 as unknown as number,
      platformFee: 10 as unknown as number,
      participants: [
        { status: 'INVITED', paidAt: null, user: { name: 'Ana' } },
      ],
      invites: [],
    });

    const result = await service.getWaitingRoomStatus('challenge-1');

    // 1 * 5 - 10 = -5 -> clamped to 0
    expect(result.prize).toBe('0.00');
  });

  it('throws NotFoundException for an unknown challenge', async () => {
    prisma.challenge.findUnique.mockResolvedValueOnce(null);

    await expect(service.getWaitingRoomStatus('missing')).rejects.toThrow(NotFoundException);
  });
});
