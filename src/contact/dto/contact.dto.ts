import { Transform } from 'class-transformer';
import { Allow, Equals, IsEmail, IsNumber, IsOptional, IsString, Length, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class ContactDto {
  @Transform(trim)
  @IsString()
  @Length(2, 120, { message: 'Informe seu nome.' })
  nome: string;

  @Transform(trim)
  @IsEmail({}, { message: 'Confira o e-mail informado.' })
  @MaxLength(200)
  email: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  assunto?: string;

  @Transform(trim)
  @IsString()
  @Length(10, 5000, { message: 'A mensagem precisa ter entre 10 e 5000 caracteres.' })
  mensagem: string;

  @Equals(true, { message: 'É preciso autorizar o uso dos dados para enviar.' })
  consentimento: boolean;

  // Isca invisível na página — humano nenhum preenche.
  @Allow()
  botcheck?: unknown;

  // Quanto tempo a página ficou aberta antes do envio, medido no navegador.
  @IsOptional()
  @IsNumber()
  duracao_ms?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  origem?: string;
}
