import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
// `import * as` (not a default import): this project sets
// allowSyntheticDefaultImports without esModuleInterop, so a default import of
// the CJS supertest module type-checks but is undefined at runtime.
import * as request from 'supertest';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * HTTP-status contract for POST /payments/webhook (#3).
 *
 * This is the test that actually pins the fix down. Mercado Pago's retry
 * behavior keys on ONE thing — the status code it receives — so "handleWebhook
 * returns vs throws" only matters insofar as it becomes 200 vs non-200 on the
 * wire. The service-level specs assert the return/throw; this asserts what MP
 * observes, through the real Nest exception layer and past the route's
 * `@HttpCode(200)` decorator (which rewrites the SUCCESS status only — the same
 * property `participants.controller.spec.ts` pins for @HttpCode(201)/409).
 *
 * Without this, "a permanent 404 stops the infinite retry loop" would rest on
 * an untested assumption about a decorator.
 */
describe('PaymentsController — webhook ack/retry HTTP contract (#3)', () => {
  let app: INestApplication;
  let paymentsService: { verifySignature: jest.Mock; handleWebhook: jest.Mock };

  beforeEach(async () => {
    paymentsService = {
      verifySignature: jest.fn().mockReturnValue(true),
      handleWebhook: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [{ provide: PaymentsService, useValue: paymentsService }],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const postWebhook = (dataId: string) =>
    request(app.getHttpServer())
      .post(`/payments/webhook?data.id=${dataId}`)
      .send({ action: 'payment.updated', type: 'payment', data: { id: dataId } });

  it('answers 200 when handleWebhook returns — MP stops retrying (the permanent-404 ack path)', async () => {
    paymentsService.handleWebhook.mockResolvedValueOnce({ activated: false });

    const response = await postWebhook('170356446929');

    expect(response.status).toBe(200);
  });

  it('answers non-200 when handleWebhook throws — MP retries (the transient path)', async () => {
    paymentsService.handleWebhook.mockRejectedValueOnce(
      new ServiceUnavailableException('Não foi possível confirmar o pagamento agora.'),
    );

    const response = await postWebhook('mp-ext-1');

    expect(response.status).toBe(503);
    expect(response.status).not.toBe(200);
  });

  it('a raw non-Error rejection (the shape the MP SDK actually throws) is still non-200, never a silent ack', async () => {
    // RestClient.fetch does `throw await response.json()`, so an unmapped
    // provider rejection is a PLAIN OBJECT. Nest cannot classify it and falls
    // back to 500 — which is still a retry signal, i.e. failing safe.
    paymentsService.handleWebhook.mockRejectedValueOnce({
      message: 'Payment not found',
      error: 'not_found',
      status: 404,
      cause: [{ code: 2000 }],
    });

    const response = await postWebhook('mp-ext-1');

    expect(response.status).not.toBe(200);
  });

  it('answers 403 (non-200) on an invalid signature — unchanged', async () => {
    paymentsService.verifySignature.mockReturnValueOnce(false);

    const response = await postWebhook('mp-ext-1');

    expect(response.status).toBe(403);
    expect(paymentsService.handleWebhook).not.toHaveBeenCalled();
  });
});
