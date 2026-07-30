import { ConflictException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
// `import * as` (not a default import): this project sets
// allowSyntheticDefaultImports without esModuleInterop, so a default import of
// the CJS supertest module type-checks but is undefined at runtime. Matches the
// existing e2e specs in test/.
import * as request from 'supertest';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ParticipantsController } from './participants.controller';
import { ParticipantsService } from './participants.service';

/**
 * HTTP-status contract for POST /participants/me/pay.
 *
 * Exists because the route carries `@HttpCode(201)`: this pins down that the
 * decorator only rewrites the SUCCESS status and never swallows a thrown
 * HttpException's status. Without this test, the "#1a refuses with 409" claim
 * would rest on the service throwing the right exception class alone — which
 * says nothing about what the client actually receives.
 */
describe('ParticipantsController (HTTP status contract)', () => {
  let app: INestApplication;
  let participantsService: { payEntry: jest.Mock };

  const challengeId = '4bf8ee39-491e-4baf-be75-871638b1491c';

  beforeEach(async () => {
    participantsService = { payEntry: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      controllers: [ParticipantsController],
      providers: [{ provide: ParticipantsService, useValue: participantsService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => { user?: unknown } };
        }) => {
          ctx.switchToHttp().getRequest().user = { id: 'user-1', email: 'joao@example.com' };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers 409 (not 201) when the entry was already paid — @HttpCode(201) does not mask the ConflictException (#1a)', async () => {
    participantsService.payEntry.mockRejectedValueOnce(
      new ConflictException('Sua entrada neste desafio já foi paga.'),
    );

    const response = await request(app.getHttpServer())
      .post('/participants/me/pay')
      .send({ challengeId });

    expect(response.status).toBe(409);
    expect(response.body.message).toBe('Sua entrada neste desafio já foi paga.');
  });

  it('still answers 201 with the QR payload on the happy path', async () => {
    participantsService.payEntry.mockResolvedValueOnce({
      qrCode: '00020126...copia-e-cola',
      qrCodeBase64: 'base64-qr-data',
      ticketUrl: 'https://www.mercadopago.com/ticket/123',
      expiresAt: new Date('2026-07-30T19:00:00.000Z'),
      paymentId: 'payment-1',
      participantId: 'participant-1',
      challengeId,
    });

    const response = await request(app.getHttpServer())
      .post('/participants/me/pay')
      .send({ challengeId });

    expect(response.status).toBe(201);
    expect(response.body.paymentId).toBe('payment-1');
  });
});
