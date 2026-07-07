export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

export interface IEmailProvider {
  send(params: SendEmailParams): Promise<{ id?: string }>;
}
