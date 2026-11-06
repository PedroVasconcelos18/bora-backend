import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { SignupDto } from './dto/signup.dto';

describe('AuthService.signup (quick 260714-gl5 — backfill emit)', () => {
  let service: AuthService;
  let prisma: {
    user: { findUnique: jest.Mock; create: jest.Mock };
    refreshToken: { create: jest.Mock };
  };
  let eventEmitter: { emitAsync: jest.Mock };

  const dto: SignupDto = {
    email: 'Joao@Example.COM',
    name: 'João',
    password: 'senha12345',
  };

  const createdUser = {
    id: 'user-1',
    email: 'joao@example.com',
    name: 'João',
    passwordHash: 'hashed',
  };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn(), create: jest.fn() },
      refreshToken: { create: jest.fn() },
    };

    eventEmitter = { emitAsync: jest.fn().mockResolvedValue([]) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { sign: jest.fn() } },
        { provide: ConfigService, useValue: { getOrThrow: jest.fn() } },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  it('emits user.signed_up with { userId, email } (lowercased) after creating the account', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.user.create.mockResolvedValueOnce(createdUser);

    await service.signup(dto);

    expect(eventEmitter.emitAsync).toHaveBeenCalledTimes(1);
    expect(eventEmitter.emitAsync).toHaveBeenCalledWith('user.signed_up', {
      userId: 'user-1',
      email: 'joao@example.com',
    });
  });

  it('still resolves with the created UserPayload when emitAsync rejects', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    prisma.user.create.mockResolvedValueOnce(createdUser);
    eventEmitter.emitAsync.mockRejectedValueOnce(new Error('boom'));

    await expect(service.signup(dto)).resolves.toEqual({
      id: 'user-1',
      email: 'joao@example.com',
      name: 'João',
    });
  });

  it('throws ConflictException and never emits when the email already exists', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'existing-user' });

    await expect(service.signup(dto)).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
  });
});

describe('AuthService.deleteAccount (lojas: exclusão de conta)', () => {
  const userId = 'user-1';
  let service: AuthService;
  let tx: Record<string, Record<string, jest.Mock>>;

  beforeEach(async () => {
    const del = () => ({ deleteMany: jest.fn().mockResolvedValue({ count: 0 }) });
    tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: userId, email: 'joao@example.com' }),
        update: jest.fn().mockResolvedValue({}),
      },
      invite: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      refreshToken: del(),
      passwordResetToken: del(),
      notification: del(),
      pushSubscription: del(),
      notificationPreference: del(),
    };
    const prisma = { $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { sign: jest.fn() } },
        { provide: ConfigService, useValue: { getOrThrow: jest.fn() } },
        { provide: EventEmitter2, useValue: { emitAsync: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  it('anonymizes identity (name, email, password) but never touches Pix keys', async () => {
    await service.deleteAccount(userId);

    const { where, data } = tx.user.update.mock.calls[0][0];
    expect(where).toEqual({ id: userId });
    expect(data.name).toBe('Conta excluída');
    expect(data.email).toBe(`excluida-${userId}@excluida.invalid`);
    expect(data.passwordHash).toBe('');
    expect(data).not.toHaveProperty('pixKey');
    expect(data).not.toHaveProperty('pixKeys');
  });

  it('rewrites invites addressed to the old email so it no longer lingers', async () => {
    await service.deleteAccount(userId);

    expect(tx.invite.updateMany).toHaveBeenCalledWith({
      where: { targetEmail: { equals: 'joao@example.com', mode: 'insensitive' } },
      data: { targetEmail: `excluida-${userId}@excluida.invalid` },
    });
  });

  it('drops sessions, reset tokens, notifications and push data scoped to the caller', async () => {
    await service.deleteAccount(userId);

    for (const model of [
      'refreshToken',
      'passwordResetToken',
      'notification',
      'pushSubscription',
      'notificationPreference',
    ]) {
      expect(tx[model].deleteMany).toHaveBeenCalledWith({ where: { userId } });
    }
  });
});
