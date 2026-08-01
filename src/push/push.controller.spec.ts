import { Test } from '@nestjs/testing';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { UserPayload } from '../auth/strategies/jwt.strategy';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';

describe('PushController (JWT-scoped — T-11-07/08/09)', () => {
  let controller: PushController;
  let pushService: {
    upsertSubscription: jest.Mock;
    deleteSubscription: jest.Mock;
    getStatus: jest.Mock;
  };

  const user: UserPayload = { id: 'user-1', email: 'a@bora.app', name: 'A' };

  const dto: CreateSubscriptionDto = {
    endpoint: 'https://push.example.com/abc123',
    keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
  };

  beforeEach(async () => {
    pushService = {
      upsertSubscription: jest.fn().mockResolvedValue({ enabled: true, endpoints: [dto.endpoint] }),
      deleteSubscription: jest.fn().mockResolvedValue({ enabled: false, endpoints: [] }),
      getStatus: jest.fn().mockResolvedValue({ enabled: true, endpoints: [dto.endpoint] }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [PushController],
      providers: [{ provide: PushService, useValue: pushService }],
    }).compile();

    controller = moduleRef.get(PushController);
  });

  describe('POST /push/subscriptions', () => {
    it('forwards the JWT user id and the DTO to PushService.upsertSubscription', async () => {
      const result = await controller.subscribe(dto, user);

      expect(pushService.upsertSubscription).toHaveBeenCalledWith(user.id, dto);
      expect(result).toEqual({ enabled: true, endpoints: [dto.endpoint] });
    });
  });

  describe('POST /push/subscriptions/unsubscribe', () => {
    it('forwards the JWT user id and the endpoint to PushService.deleteSubscription', async () => {
      const result = await controller.unsubscribe({ endpoint: dto.endpoint }, user);

      expect(pushService.deleteSubscription).toHaveBeenCalledWith(user.id, dto.endpoint);
      expect(result).toEqual({ enabled: false, endpoints: [] });
    });
  });

  describe('GET /push/status', () => {
    it('forwards the JWT user id to PushService.getStatus', async () => {
      const result = await controller.status(user);

      expect(pushService.getStatus).toHaveBeenCalledWith(user.id);
      expect(result).toEqual({ enabled: true, endpoints: [dto.endpoint] });
    });
  });

  it('no handler reads a user id from the request body, query or params', async () => {
    await controller.subscribe(dto, user);
    await controller.unsubscribe({ endpoint: dto.endpoint }, user);
    await controller.status(user);

    // Every call must have been made with exactly user.id as the identity —
    // never a value sourced from dto/body.
    expect(pushService.upsertSubscription.mock.calls[0][0]).toBe(user.id);
    expect(pushService.deleteSubscription.mock.calls[0][0]).toBe(user.id);
    expect(pushService.getStatus.mock.calls[0][0]).toBe(user.id);
  });
});
