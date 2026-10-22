export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  /** Para onde vai a resposta — ex.: o e-mail de quem escreveu no formulário de contato. */
  replyTo?: string;
}

export interface IEmailProvider {
  send(params: SendEmailParams): Promise<{ id?: string }>;
}
