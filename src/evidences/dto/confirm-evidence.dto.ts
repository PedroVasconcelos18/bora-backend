import { IsString, IsUUID } from 'class-validator';

export class ConfirmEvidenceDto {
  @IsUUID()
  challengeId!: string;

  @IsString()
  objectKey!: string;
}
