import {
  ArrayMinSize,
  IsEmail,
  IsInt,
  IsNumber,
  IsString,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateChallengeDto {
  @IsString()
  title!: string;

  @IsString()
  emoji!: string;

  @IsInt()
  @Min(3)
  durationDays!: number;

  @IsNumber()
  @Min(5)
  @Transform(({ value }: { value: unknown }) => Number(value))
  collabAmount!: number;

  @IsEmail({}, { each: true })
  @ArrayMinSize(2)
  invitees!: string[];
}
