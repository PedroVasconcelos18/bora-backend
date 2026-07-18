import { Test } from '@nestjs/testing';
import { ProfileService } from './profile.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ProfileService.getStats (PROF-01)', () => {
  let service: ProfileService;
  let prisma: {
    participant: { count: jest.Mock };
    evidence: { count: jest.Mock };
    user: { findUnique: jest.Mock; update: jest.Mock };
  };

  const userId = 'user-1';

  beforeEach(async () => {
    prisma = {
      participant: { count: jest.fn() },
      evidence: { count: jest.fn() },
      user: { findUnique: jest.fn(), update: jest.fn() },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [ProfileService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(ProfileService);
  });

  it('counts PAID+ACTIVE participants as activeChallenges, scoped to the caller', async () => {
    prisma.participant.count.mockResolvedValueOnce(2);
    prisma.evidence.count.mockResolvedValueOnce(0);

    const result = await service.getStats(userId);

    expect(result.activeChallenges).toBe(2);
    expect(prisma.participant.count).toHaveBeenCalledWith({
      where: { userId, status: 'PAID', challenge: { status: 'ACTIVE' } },
    });
  });

  it('counts ACCEPTED evidences across all challenges (any status) as validatedDays', async () => {
    prisma.participant.count.mockResolvedValueOnce(0);
    prisma.evidence.count.mockResolvedValueOnce(5);

    const result = await service.getStats(userId);

    expect(result.validatedDays).toBe(5);
    expect(prisma.evidence.count).toHaveBeenCalledWith({
      where: { participant: { userId }, status: 'ACCEPTED' },
    });
  });

  it('returns zeroed stats for a user with no participants', async () => {
    prisma.participant.count.mockResolvedValueOnce(0);
    prisma.evidence.count.mockResolvedValueOnce(0);

    const result = await service.getStats(userId);

    expect(result).toEqual({ activeChallenges: 0, validatedDays: 0 });
  });

  it('scopes both counts to the caller only — never accepts another user id', async () => {
    prisma.participant.count.mockResolvedValueOnce(1);
    prisma.evidence.count.mockResolvedValueOnce(3);

    await service.getStats(userId);

    const participantWhere = prisma.participant.count.mock.calls[0][0].where;
    const evidenceWhere = prisma.evidence.count.mock.calls[0][0].where;
    expect(participantWhere.userId).toBe(userId);
    expect(evidenceWhere.participant.userId).toBe(userId);
  });
});

describe('ProfileService.getProfile/updatePixKey (T-i98-01, D-1/D-4)', () => {
  let service: ProfileService;
  let prisma: {
    participant: { count: jest.Mock };
    evidence: { count: jest.Mock };
    user: { findUnique: jest.Mock; update: jest.Mock };
  };

  const userId = 'user-1';

  beforeEach(async () => {
    prisma = {
      participant: { count: jest.fn() },
      evidence: { count: jest.fn() },
      user: { findUnique: jest.fn(), update: jest.fn() },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [ProfileService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(ProfileService);
  });

  it("getProfile returns the row's pixKey + pixKeys, scoped to the caller's id", async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ pixKey: 'joao@pix', pixKeys: ['joao@pix'] });

    const result = await service.getProfile(userId);

    expect(result).toEqual({ pixKey: 'joao@pix', pixKeys: ['joao@pix'] });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: userId },
      select: { pixKey: true, pixKeys: true },
    });
  });

  it('getProfile returns empty when the user has no key set', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ pixKey: null, pixKeys: [] });

    const result = await service.getProfile(userId);

    expect(result).toEqual({ pixKey: null, pixKeys: [] });
  });

  it('updatePixKeys trims, drops blanks, dedupes, and mirrors the first into pixKey', async () => {
    prisma.user.update.mockResolvedValueOnce({});

    const result = await service.updatePixKeys(userId, ['  joao@pix  ', '', 'joao@pix', '11987654321']);

    expect(result).toEqual({ pixKey: 'joao@pix', pixKeys: ['joao@pix', '11987654321'] });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: { pixKeys: ['joao@pix', '11987654321'], pixKey: 'joao@pix' },
    });
  });

  it('updatePixKeys clears everything when the list is empty (pixKey null)', async () => {
    prisma.user.update.mockResolvedValueOnce({});

    const result = await service.updatePixKeys(userId, ['   ', '']);

    expect(result).toEqual({ pixKey: null, pixKeys: [] });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: { pixKeys: [], pixKey: null },
    });
  });

  it('updatePixKeys caps the list at 5 keys', async () => {
    prisma.user.update.mockResolvedValueOnce({});

    const result = await service.updatePixKeys(userId, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);

    expect(result.pixKeys).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(result.pixKey).toBe('a');
  });
});
