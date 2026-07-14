import {
  ArrayMaxSize,
  ArrayMinSize,
  IsEmail,
  IsInt,
  IsNumber,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateChallengeDto {
  @IsString()
  title!: string;

  @IsString()
  emoji!: string;

  @IsInt()
  @Min(3, { message: 'A duração mínima é de 3 dias.' })
  @Max(365, { message: 'A duração máxima é de 365 dias.' })
  durationDays!: number;

  @IsNumber()
  @Min(5, { message: 'A colaboração mínima é R$ 5.' })
  @Max(200, { message: 'A colaboração máxima é R$ 200.' })
  @Transform(({ value }: { value: unknown }) => Number(value))
  collabAmount!: number;

  @IsEmail({}, { each: true })
  @ArrayMinSize(2, { message: 'Convide pelo menos 2 amigos (mínimo de 3 pessoas).' })
  // Teto de 9 convidados, não 10: participantes totais = criador + convidados,
  // e o limite de participantes é 10 (maxParticipants) — o criador ocupa uma vaga.
  @ArrayMaxSize(9, { message: 'O desafio aceita no máximo 10 pessoas — convide até 9 amigos.' })
  invitees!: string[];
}
