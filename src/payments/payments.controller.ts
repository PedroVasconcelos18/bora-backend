import { Body, Controller, ForbiddenException, Headers, HttpCode, Post, Query } from '@nestjs/common';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  /**
   * POST /payments/webhook
   * Public — deliberately carries NO @UseGuards. Called by Mercado Pago's
   * servers, not an authenticated user (RESEARCH.md Pattern 2).
   *
   * Non-200 (ForbiddenException) on an invalid x-signature — MP retries on
   * non-200, which is the correct behavior for a forged/misconfigured
   * sender. On a valid signature, delegates to handleWebhook, which never
   * trusts the body and re-confirms via GET /v1/payments/{id} (D-15).
   */
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Headers('x-signature') xSignature: string | undefined,
    @Headers('x-request-id') xRequestId: string | undefined,
    @Query('data.id') dataId: string,
    @Body() body: unknown,
  ) {
    const valid = this.paymentsService.verifySignature(xSignature, xRequestId, dataId);

    if (!valid) {
      throw new ForbiddenException('Assinatura do webhook inválida.');
    }

    await this.paymentsService.handleWebhook(dataId, body);

    return { received: true };
  }
}
