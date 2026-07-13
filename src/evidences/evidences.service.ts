import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client.js';
import { IObjectStorage, UploadUrlResult } from '../storage/interfaces/object-storage.interface';
import { saoPauloDay } from '../common/utils/sao-paulo-day.util';

export interface PresignUploadResult {
  uploadUrl: string;
  objectKey: string;
  expiresAt: Date;
}

// D-07: the vote window is a full 24h, anchored to the evidence's post time.
const VOTE_WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class EvidencesService {
  private readonly logger = new Logger(EvidencesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject('OBJECT_STORAGE') private readonly objectStorage: IObjectStorage,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Resolves the caller's own Participant row for the challenge (never a
   * client-supplied participantId — T-03-03) and re-checks the paid + ACTIVE
   * gate (T-03-02, A2: status === 'PAID' only — confirmed against this repo's
   * ParticipantStatus usage, which never transitions a participant to ACTIVE
   * after challenge activation).
   */
  private async resolveEligibleParticipant(userId: string, challengeId: string) {
    const participant = await this.prisma.participant.findUnique({
      where: { challengeId_userId: { challengeId, userId } },
      include: { challenge: true },
    });

    if (!participant) {
      throw new NotFoundException('Você não é participante deste desafio.');
    }

    if (participant.status !== 'PAID') {
      throw new ForbiddenException('Apenas participantes pagos podem postar evidência.');
    }

    if (participant.challenge.status !== 'ACTIVE') {
      throw new ForbiddenException('O desafio ainda não está ativo.');
    }

    return participant;
  }

  /** T-03-01: the objectKey is always server-generated, never a client value. */
  private buildObjectKey(challengeId: string, participantId: string, evidenceDate: string): string {
    return `evidences/${challengeId}/${participantId}/${evidenceDate}.jpg`;
  }

  /**
   * Mints a presigned PUT URL WITHOUT writing an Evidence row (Pitfall 1 —
   * two-step flow: the row is only created by confirmEvidence after the
   * client's PUT actually succeeds). Re-checks the paid gate, the ACTIVE
   * gate, and the one-per-day (America/Sao_Paulo) gate before minting.
   */
  async presignUpload(
    userId: string,
    challengeId: string,
    contentType: string,
  ): Promise<PresignUploadResult> {
    const participant = await this.resolveEligibleParticipant(userId, challengeId);
    const evidenceDate = saoPauloDay();

    const existing = await this.prisma.evidence.findUnique({
      where: { participantId_evidenceDate: { participantId: participant.id, evidenceDate } },
    });

    if (existing) {
      throw new ConflictException('Você já postou a evidência de hoje.');
    }

    const objectKey = this.buildObjectKey(challengeId, participant.id, evidenceDate);

    let result: UploadUrlResult;
    try {
      result = await this.objectStorage.getUploadUrl({ key: objectKey, contentType });
    } catch (err) {
      this.logger.error(
        `presignUpload: objectStorage.getUploadUrl failed for participant ${participant.id}: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }`,
      );
      throw new ServiceUnavailableException(
        'Não foi possível preparar o upload agora. Tente novamente.',
      );
    }

    return { uploadUrl: result.uploadUrl, objectKey: result.objectKey, expiresAt: result.expiresAt };
  }

  /**
   * Called by the client only after a successful direct-to-R2 PUT. Re-checks
   * the paid + ACTIVE gate (a participant's paid status or the challenge's
   * state could have changed since presign-mint), verifies the reported
   * objectKey matches the server-derived key for this participant/day
   * (T-03-01 — rejects a tampered/mismatched key), then creates the Evidence
   * row. The one-per-day gate is re-checked here AND backed by the DB
   * @@unique([participantId, evidenceDate]) constraint — a P2002 violation
   * (e.g. a race between two concurrent confirms) is surfaced as a 409
   * ConflictException, never a raw 500 (EVID-03).
   */
  async confirmEvidence(userId: string, challengeId: string, objectKey: string) {
    const participant = await this.resolveEligibleParticipant(userId, challengeId);
    const evidenceDate = saoPauloDay();

    const expectedKey = this.buildObjectKey(challengeId, participant.id, evidenceDate);
    if (objectKey !== expectedKey) {
      throw new ForbiddenException('Chave de objeto inválida.');
    }

    const existing = await this.prisma.evidence.findUnique({
      where: { participantId_evidenceDate: { participantId: participant.id, evidenceDate } },
    });

    if (existing) {
      throw new ConflictException('Você já postou a evidência de hoje.');
    }

    const windowClosesAt = new Date(Date.now() + VOTE_WINDOW_MS);

    try {
      const evidence = await this.prisma.evidence.create({
        data: {
          challengeId,
          participantId: participant.id,
          objectKey,
          evidenceDate,
          windowClosesAt,
        },
      });

      this.logger.log(
        `confirmEvidence: created evidence ${evidence.id} for participant ${participant.id} (day=${evidenceDate})`,
      );

      // NOTIF-02 (D-02): create() is a single isolated write — no
      // $transaction here — so this is already post-commit by construction,
      // no restructuring needed.
      this.eventEmitter.emit('evidence.submitted', {
        evidenceId: evidence.id,
        participantId: participant.id,
        challengeId,
      });

      return evidence;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Você já postou a evidência de hoje.');
      }
      throw err;
    }
  }

  /**
   * GET /challenges/:id/evidences/today — the caller's own evidence for
   * today, if any (feeds the "posted-today" UI state). Never another
   * participant's evidence — resolved from the caller's own Participant row.
   */
  async getTodayEvidence(userId: string, challengeId: string) {
    const participant = await this.prisma.participant.findUnique({
      where: { challengeId_userId: { challengeId, userId } },
    });

    if (!participant) {
      throw new NotFoundException('Você não é participante deste desafio.');
    }

    const evidenceDate = saoPauloDay();

    return this.prisma.evidence.findUnique({
      where: { participantId_evidenceDate: { participantId: participant.id, evidenceDate } },
    });
  }
}
