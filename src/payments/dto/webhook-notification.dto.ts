/**
 * Shape of the Mercado Pago webhook notification body (documentation only —
 * NOT used as a class-validator @Body() target: the real MP payload carries
 * several additional top-level fields (live_mode, date_created,
 * application_id, user_id, api_version, action, ...) that a whitelist-strict
 * DTO would reject under the global ValidationPipe's
 * forbidNonWhitelisted:true. The webhook body is never trusted directly
 * either way (D-15) — only `data.id` (read from the query param, not the
 * body) drives the GET /v1/payments/{id} verify-via-API call. The raw body
 * is stored as-is for debugging (Payment.rawWebhookPayload).
 */
export class WebhookNotificationDto {
  type?: string;
  data?: {
    id?: string;
  };
}
