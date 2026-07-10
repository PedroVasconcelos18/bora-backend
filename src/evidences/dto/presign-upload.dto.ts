import { IsIn, IsUUID } from 'class-validator';
import { ALLOWED_IMAGE_CONTENT_TYPES } from '../../storage/storage.constants';

// V5 (RESEARCH.md Security Domain): MIME allowlist rejects non-image content
// before minting a URL. Shared with the local StorageController's PUT gate so
// the presign contract and the byte-accepting endpoint agree exactly.
export class PresignUploadDto {
  @IsUUID()
  challengeId!: string;

  @IsIn(ALLOWED_IMAGE_CONTENT_TYPES)
  contentType!: string;
}
