export interface CreatePixChargeParams {
  amount: number;
  description: string;
  payerEmail: string;
  externalReference: string;
  expirationMinutes: number;
  idempotencyKey: string;
}

export interface PixChargeResult {
  externalId: string;
  qrCode: string;
  qrCodeBase64: string;
  ticketUrl: string;
  expiresAt: Date;
}

export interface IPaymentProvider {
  createPixCharge(params: CreatePixChargeParams): Promise<PixChargeResult>;
  getPayment(externalId: string): Promise<{ status: string; externalReference: string | null }>;
}
