import { Test } from '@nestjs/testing';
import { PushPreferencesController } from './push-preferences.controller';
import { PushPreferencesService } from './push-preferences.service';
import { UserPayload } from '../auth/strategies/jwt.strategy';
import { UpdatePreferenceDto } from './dto/update-preference.dto';

describe('PushPreferencesController (JWT-scoped — T-12-14)', () => {
  let controller: PushPreferencesController;
  let prefs: {
    listPreferences: jest.Mock;
    setPreference: jest.Mock;
  };

  const user: UserPayload = { id: 'user-1', email: 'a@bora.app', name: 'A' };
  const listResult = [{ type: 'INVITE_RECEIVED', enabled: true }];

  const dto: UpdatePreferenceDto = { type: 'EVIDENCE_REMINDER', enabled: false } as UpdatePreferenceDto;

  beforeEach(async () => {
    prefs = {
      listPreferences: jest.fn().mockResolvedValue(listResult),
      setPreference: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [PushPreferencesController],
      providers: [{ provide: PushPreferencesService, useValue: prefs }],
    }).compile();

    controller = moduleRef.get(PushPreferencesController);
  });

  describe('GET /push/preferences', () => {
    it('forwards the JWT user id to PushPreferencesService.listPreferences', async () => {
      const result = await controller.list(user);

      expect(prefs.listPreferences).toHaveBeenCalledWith(user.id);
      expect(result).toEqual(listResult);
    });
  });

  describe('POST /push/preferences', () => {
    it('forwards the JWT user id and the DTO to setPreference, then returns the updated list', async () => {
      const result = await controller.update(dto, user);

      expect(prefs.setPreference).toHaveBeenCalledWith(user.id, dto.type, dto.enabled);
      expect(prefs.listPreferences).toHaveBeenCalledWith(user.id);
      expect(result).toEqual(listResult);
    });
  });

  it('no handler reads a user id from the request body, query or params', async () => {
    await controller.list(user);
    await controller.update(dto, user);

    expect(prefs.listPreferences.mock.calls[0][0]).toBe(user.id);
    expect(prefs.setPreference.mock.calls[0][0]).toBe(user.id);
  });
});
