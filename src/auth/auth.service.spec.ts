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
