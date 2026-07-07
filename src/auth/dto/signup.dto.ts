import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

export class SignupDto {
  @IsEmail({}, { message: 'E-mail inválido.' })
  email: string;

  @IsString()
  @MinLength(1, { message: 'Nome é obrigatório.' })
  @MaxLength(100, { message: 'Nome muito longo.' })
  name: string;

  @IsString()
  @MinLength(8, { message: 'A senha deve ter no mínimo 8 caracteres.' })
  @MaxLength(128, { message: 'Senha muito longa.' })
  password: string;
}
