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

  it("getProfile returns the row's pixKey, scoped to the caller's id", async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ pixKey: 'joao@pix' });

    const result = await service.getProfile(userId);

    expect(result).toEqual({ pixKey: 'joao@pix' });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: userId },
      select: { pixKey: true },
    });
  });

  it('getProfile returns { pixKey: null } when the user has no key set', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ pixKey: null });

    const result = await service.getProfile(userId);

    expect(result).toEqual({ pixKey: null });
  });

  it('updatePixKey trims surrounding whitespace before storing', async () => {
    prisma.user.update.mockResolvedValueOnce({});

    const result = await service.updatePixKey(userId, '  joao@pix  ');

    expect(result).toEqual({ pixKey: 'joao@pix' });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: { pixKey: 'joao@pix' },
    });
  });

  it('updatePixKey stores null when the input is all-whitespace (clears the key)', async () => {
    prisma.user.update.mockResolvedValueOnce({});

    const result = await service.updatePixKey(userId, '   ');

    expect(result).toEqual({ pixKey: null });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: { pixKey: null },
    });
  });

  it('updatePixKey stores a non-empty value unchanged (no format validation, D-4)', async () => {
    prisma.user.update.mockResolvedValueOnce({});

    const result = await service.updatePixKey(userId, '11987654321');

    expect(result).toEqual({ pixKey: '11987654321' });
  });
});
