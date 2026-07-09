import { IsIn, IsUUID } from 'class-validator';

// V5 (RESEARCH.md Security Domain): MIME allowlist rejects non-image content
// before minting a URL.
const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export class PresignUploadDto {
  @IsUUID()
  challengeId!: string;

  @IsIn(ALLOWED_CONTENT_TYPES)
  contentType!: string;
}
