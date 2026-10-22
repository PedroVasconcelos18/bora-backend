import { BadGatewayException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContactController } from './contact.controller';
import { ContactDto } from './dto/contact.dto';

describe('ContactController', () => {
  const dto: ContactDto = {
    nome: 'Ana <b>',
    email: 'ana@example.com',
    assunto: 'Outro assunto',
    mensagem: 'Oi, tenho uma dúvida sobre o desafio.',
    consentimento: true,
    duracao_ms: 15000,
  };
  const make = (to: string | undefined, send = jest.fn().mockResolvedValue({ id: '1' })) => ({
    send,
    controller: new ContactController({ send }, { get: () => to } as unknown as ConfigService),
  });

  it('envia para CONTACT_EMAIL_TO com reply-to de quem escreveu e HTML escapado', async () => {
    const { controller, send } = make('caixa@borajuntos.app');
    await expect(controller.send(dto)).resolves.toEqual({ ok: true });
    const arg = send.mock.calls[0][0];
    expect(arg.to).toBe('caixa@borajuntos.app');
    expect(arg.replyTo).toBe('ana@example.com');
    expect(arg.html).toContain('Ana &lt;b&gt;');
    expect(arg.html).not.toContain('<b>');
  });

  it('isca preenchida: 200 mudo, nada enviado', async () => {
    const { controller, send } = make('caixa@borajuntos.app');
    await expect(controller.send({ ...dto, botcheck: 'on' })).resolves.toEqual({ ok: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('envio rápido demais: 400 recuperável', async () => {
    const { controller } = make('caixa@borajuntos.app');
    await expect(controller.send({ ...dto, duracao_ms: 500 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sem CONTACT_EMAIL_TO: 503, nunca um falso "recebemos"', async () => {
    const { controller, send } = make(undefined);
    await expect(controller.send(dto)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(send).not.toHaveBeenCalled();
  });

  it('falha do provedor vira 502', async () => {
    const { controller } = make('caixa@borajuntos.app', jest.fn().mockRejectedValue(new Error('down')));
    await expect(controller.send(dto)).rejects.toBeInstanceOf(BadGatewayException);
  });
});
