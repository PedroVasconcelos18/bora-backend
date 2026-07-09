import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserPayload } from '../auth/strategies/jwt.strategy';
import { EvidencesService } from './evidences.service';
import { PresignUploadDto } from './dto/presign-upload.dto';
import { ConfirmEvidenceDto } from './dto/confirm-evidence.dto';

/**
 * No class-level route prefix: this controller spans two distinct URL
 * families (/evidences/* and /challenges/:id/evidences/today), so each
 * handler declares its own full path instead of sharing an @Controller('x')
 * prefix. All three endpoints resolve the caller's Participant row
 * server-side from @CurrentUser() + challengeId — never a client-supplied
 * participantId (T-03-03).
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class EvidencesController {
  constructor(private readonly evidencesService: EvidencesService) {}

  /** POST /evidences/presign — mint a presigned PUT URL (no row written). */
  @Post('evidences/presign')
  @HttpCode(201)
  async presign(@Body() dto: PresignUploadDto, @CurrentUser() currentUser: UserPayload) {
    return this.evidencesService.presignUpload(currentUser.id, dto.challengeId, dto.contentType);
  }

  /** POST /evidences — confirm a completed upload and create the Evidence row. */
  @Post('evidences')
  @HttpCode(201)
  async confirm(@Body() dto: ConfirmEvidenceDto, @CurrentUser() currentUser: UserPayload) {
    return this.evidencesService.confirmEvidence(currentUser.id, dto.challengeId, dto.objectKey);
  }

  /** GET /challenges/:id/evidences/today — the caller's own evidence for today, if any. */
  @Get('challenges/:id/evidences/today')
  async today(@Param('id') challengeId: string, @CurrentUser() currentUser: UserPayload) {
    return this.evidencesService.getTodayEvidence(currentUser.id, challengeId);
  }
}
