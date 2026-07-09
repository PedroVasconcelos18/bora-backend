import { Test } from '@nestjs/testing';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { EvidencesService } from './evidences.service';
import { PrismaService } from '../prisma/prisma.service';
import { IObjectStorage } from '../storage/interfaces/object-storage.interface';
import { Prisma } from '../generated/prisma/client.js';

describe('EvidencesService (EVID-01/02/03)', () => {
  let service: EvidencesService;
  let objectStorage: jest.Mocked<IObjectStorage>;
  let prisma: {
    participant: { findUnique: jest.Mock };
    evidence: { findUnique: jest.Mock; create: jest.Mock };
  };

  const challengeId = 'challenge-1';
  const userId = 'user-1';

  const paidParticipant = {
    id: 'participant-1',
    challengeId,
    userId,
    status: 'PAID',
    challenge: { id: challengeId, status: 'ACTIVE' },
  };

  const nonPaidParticipant = {
    ...paidParticipant,
    id: 'participant-2',
    status: 'INVITED',
  };

  beforeEach(async () => {
    objectStorage = {
      getUploadUrl: jest.fn(),
    };

    prisma = {
      participant: {
        findUnique: jest.fn().mockResolvedValue(paidParticipant),
      },
      evidence: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        EvidencesService,
        { provide: PrismaService, useValue: prisma },
        { provide: 'OBJECT_STORAGE', useValue: objectStorage },
      ],
    }).compile();

    service = moduleRef.get(EvidencesService);
  });

  describe('presignUpload', () => {
    it('throws ForbiddenException for a participant whose status !== PAID (EVID-02)', async () => {
      prisma.participant.findUnique.mockResolvedValueOnce(nonPaidParticipant);

      await expect(
        service.presignUpload(userId, challengeId, 'image/jpeg'),
      ).rejects.toThrow(ForbiddenException);
      expect(objectStorage.getUploadUrl).not.toHaveBeenCalled();
    });

    it('returns { uploadUrl, objectKey, expiresAt } for a PAID participant of an ACTIVE challenge and does NOT create an Evidence row (Pitfall 1 — two-step flow)', async () => {
      const expiresAt = new Date('2026-07-09T10:10:00.000Z');
      objectStorage.getUploadUrl.mockResolvedValue({
        uploadUrl: 'https://r2.example.com/signed-put',
        objectKey: 'evidences/challenge-1/participant-1/2026-07-09.jpg',
        expiresAt,
      });

      const result = await service.presignUpload(userId, challengeId, 'image/jpeg');

      expect(result).toEqual({
        uploadUrl: 'https://r2.example.com/signed-put',
        objectKey: expect.any(String),
        expiresAt,
      });
      expect(prisma.evidence.create).not.toHaveBeenCalled();
    });

    it('generates the objectKey server-side as evidences/{challengeId}/{participantId}/{evidenceDate}.jpg — never trusts a client-supplied key as the PUT target (Tampering mitigation)', async () => {
      objectStorage.getUploadUrl.mockResolvedValue({
        uploadUrl: 'https://r2.example.com/signed-put',
        objectKey: 'ignored-by-real-adapter-echo',
        expiresAt: new Date(),
      });

      await service.presignUpload(userId, challengeId, 'image/jpeg');

      expect(objectStorage.getUploadUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          key: expect.stringMatching(
            new RegExp(`^evidences/${challengeId}/${paidParticipant.id}/\\d{4}-\\d{2}-\\d{2}\\.jpg$`),
          ),
          contentType: 'image/jpeg',
        }),
      );
    });
  });

  describe('confirmEvidence', () => {
    it('re-checks the paid gate and rejects a non-PAID caller', async () => {
      prisma.participant.findUnique.mockResolvedValueOnce(nonPaidParticipant);

      await expect(
        service.confirmEvidence(userId, challengeId, 'evidences/challenge-1/participant-2/2026-07-09.jpg'),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.evidence.create).not.toHaveBeenCalled();
    });

    it('rejects a second evidence for the same participant on the same evidenceDate, surfacing the Prisma P2002 unique violation as ConflictException (EVID-03)', async () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`participant_id`,`evidence_date`)',
        { code: 'P2002', clientVersion: '7.8.0' },
      );
      prisma.evidence.create.mockRejectedValueOnce(p2002);

      // A real R2 adapter echoes back the exact key it was asked to sign — mirror
      // that here so the objectKey the test confirms with matches the server-derived key.
      objectStorage.getUploadUrl.mockImplementation(async ({ key }) => ({
        uploadUrl: 'https://r2.example.com/signed-put',
        objectKey: key,
        expiresAt: new Date(),
      }));
      const { objectKey } = await service.presignUpload(userId, challengeId, 'image/jpeg');

      await expect(service.confirmEvidence(userId, challengeId, objectKey)).rejects.toThrow(
        ConflictException,
      );
    });

    it('rejects a client-supplied objectKey that does not match the server-derived key (Tampering mitigation)', async () => {
      await expect(
        service.confirmEvidence(userId, challengeId, 'evidences/some-other-challenge/some-other-participant/2020-01-01.jpg'),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.evidence.create).not.toHaveBeenCalled();
    });
  });
});
