import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PushAdminController } from './push-admin.controller';
import { PushAdminService } from './push-admin.service';
import { AdminGuard } from '../admin/admin.guard';
import { AdminTestPushDto } from './dto/admin-test-push.dto';

describe('PushAdminController (Quick task 260802-by6)', () => {
  let controller: PushAdminController;
  let pushAdmin: { run: jest.Mock };

  const runResult = { dryRun: false, userId: 'user-1', evidenceDate: '2026-08-02', results: [] };

  beforeEach(async () => {
    pushAdmin = { run: jest.fn().mockResolvedValue(runResult) };

    const moduleRef = await Test.createTestingModule({
      controllers: [PushAdminController],
      providers: [{ provide: PushAdminService, useValue: pushAdmin }],
    })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(PushAdminController);
  });

  describe('sendTest', () => {
    it('delegates to PushAdminService.run and returns its response unchanged', async () => {
      const dto = { userId: 'user-1' } as AdminTestPushDto;

      const result = await controller.sendTest(dto);

      expect(pushAdmin.run).toHaveBeenCalledWith(dto);
      expect(result).toBe(runResult);
    });

    it('passes a legacy { userId, challengeIds } body through with no field lost (QT-01 compat)', async () => {
      const dto = { userId: 'user-1', challengeIds: ['c1'] } as AdminTestPushDto;

      await controller.sendTest(dto);

      expect(pushAdmin.run).toHaveBeenCalledWith({ userId: 'user-1', challengeIds: ['c1'] });
    });

    it('passes type and dryRun through intact', async () => {
      const dto = { userId: 'user-1', type: 'ALL', dryRun: true } as AdminTestPushDto;

      await controller.sendTest(dto);

      expect(pushAdmin.run).toHaveBeenCalledWith({ userId: 'user-1', type: 'ALL', dryRun: true });
    });

    it('never builds a payload or calls PushSenderService directly — PushAdminService.run is the only call', () => {
      const methodSource = controller.sendTest.toString();
      expect(methodSource).not.toMatch(/pushSender/);
    });
  });

  describe('AdminGuard metadata', () => {
    it('is applied at the class level, not loosened on the handler', () => {
      const classGuards = Reflect.getMetadata('__guards__', PushAdminController);
      expect(classGuards).toBeDefined();
      expect(classGuards).toContain(AdminGuard);

      const handlerGuards = Reflect.getMetadata('__guards__', PushAdminController.prototype.sendTest);
      expect(handlerGuards).toBeUndefined();
    });
  });
});

describe('AdminTestPushDto validation (Quick task 260802-by6)', () => {
  it('accepts { userId, type: EVIDENCE_SUBMITTED }', async () => {
    const instance = plainToInstance(AdminTestPushDto, { userId: 'u', type: 'EVIDENCE_SUBMITTED' });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('accepts { userId, type: ALL }', async () => {
    const instance = plainToInstance(AdminTestPushDto, { userId: 'u', type: 'ALL' });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('rejects an unknown type value', async () => {
    const instance = plainToInstance(AdminTestPushDto, { userId: 'u', type: 'NAO_EXISTE' });
    const errors = await validate(instance);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'type')).toBe(true);
  });

  it('rejects a non-boolean dryRun', async () => {
    const instance = plainToInstance(AdminTestPushDto, { userId: 'u', dryRun: 'sim' });
    const errors = await validate(instance);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'dryRun')).toBe(true);
  });

  it('accepts { userId } alone, leaving type and dryRun undefined', async () => {
    const instance = plainToInstance(AdminTestPushDto, { userId: 'u' });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
    expect(instance.type).toBeUndefined();
    expect(instance.dryRun).toBeUndefined();
  });

  it('rejects an empty body — userId is still required', async () => {
    const instance = plainToInstance(AdminTestPushDto, {});
    const errors = await validate(instance);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'userId')).toBe(true);
  });
});
