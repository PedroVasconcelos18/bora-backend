import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { IEmailProvider } from '../email/interfaces/email-provider.interface';
import { ThrottlerBehindProxyGuard } from '../auth/guards/throttler-behind-proxy.guard';
import { ContactDto } from './dto/contact.dto';

// Gente lê e digita; robô posta no mesmo instante. Este corte ERRA em gente de
// verdade (autofill + clique rápido cabem em 2s), por isso devolve 400
// recuperável e não um 200 mudo — lead perdido calado custa mais.
const PREENCHIMENTO_MINIMO_MS = 2000;

const escapar = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * POST /contact — o formulário da página /contato da landing (mesmo padrão
 * do site da A.lab). Público: o visitante, por definição, está deslogado.
 *
 * Variável de ambiente: CONTACT_EMAIL_TO (obrigatória) — a caixa que recebe.
 */
@Controller('contact')
export class ContactController {
  private readonly logger = new Logger(ContactController.name);

  constructor(
    @Inject('EMAIL_PROVIDER') private readonly email: IEmailProvider,
    private readonly config: ConfigService,
  ) {}

  @Post()
  @UseGuards(ThrottlerBehindProxyGuard)
  // O ThrottlerModule é @Global e só é registrado no AuthModule (D-07), com o
  // throttler nomeado 'password-reset'. Reaproveitamos o nome com limite
  // próprio; o contador é por handler, então não se mistura com o do reset.
  @Throttle({ 'password-reset': { limit: 5, ttl: 3_600_000 } }) // 5 envios / hora por IP
  @HttpCode(HttpStatus.OK)
  async send(@Body() dto: ContactDto) {
    // Isca preenchida: 200 mudo. Avisar o robô ensinaria a próxima tentativa.
    if (dto.botcheck) return { ok: true };

    if (dto.duracao_ms !== undefined && dto.duracao_ms < PREENCHIMENTO_MINIMO_MS) {
      throw new BadRequestException('Envio rápido demais. Clique em enviar outra vez.');
    }

    const to = this.config.get<string>('CONTACT_EMAIL_TO');
    if (!to) {
      // Falhar alto: um 200 aqui faria o site dizer "recebemos" para uma
      // mensagem que ninguém vai ler.
      this.logger.error('CONTACT_EMAIL_TO não configurada — envio abortado');
      throw new ServiceUnavailableException('indisponivel');
    }

    const linhas: [string, string][] = [
      ['Nome', dto.nome],
      ['E-mail', dto.email],
      ['Assunto', dto.assunto || '—'],
    ];
    const origem = dto.origem || '/contato';
    const html =
      '<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#16241C">' +
      '<h2 style="font-size:17px;margin:0 0 16px">Novo contato pelo site</h2>' +
      linhas.map(([r, v]) => `<p style="margin:0">${r}: <strong>${escapar(v)}</strong></p>`).join('') +
      `<div style="white-space:pre-wrap;border-left:3px solid #2BD86B;padding-left:14px;margin-top:20px">${escapar(dto.mensagem)}</div>` +
      `<p style="margin-top:24px;color:#5C6B61;font-size:13px">Enviado pelo formulário de ${escapar(origem)}</p></div>`;

    try {
      await this.email.send({
        to,
        // Responder no cliente de e-mail responde para a pessoa.
        replyTo: dto.email,
        subject: `Contato pelo site — ${dto.nome}${dto.assunto ? ` (${dto.assunto})` : ''}`,
        html,
      });
    } catch (e) {
      this.logger.error(`Falha ao enviar contato: ${(e as Error).message}`);
      throw new BadGatewayException('indisponivel');
    }
    return { ok: true };
  }
}
