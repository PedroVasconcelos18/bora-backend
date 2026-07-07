import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { createHash } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SignupDto } from './dto/signup.dto';
import { UserPayload } from './strategies/jwt.strategy';

// Refresh tokens: raw UUID (cryptographically strong) hashed with SHA-256 for DB lookup.
// argon2id is used for PASSWORD hashing only — it's non-deterministic and not suitable
// for DB lookups. SHA-256 is deterministic and sufficient for opaque bearer token
// storage since the raw token has 122 bits of entropy (UUID v4).
function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
  ) {}

  async signup(dto: SignupDto): Promise<UserPayload> {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (existing) {
      throw new ConflictException('Este e-mail já tem uma conta.');
    }

    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });

    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        name: dto.name,
        passwordHash,
      },
    });

    return { id: user.id, email: user.email, name: user.name };
  }

  async validateUser(
    email: string,
    password: string,
  ): Promise<UserPayload | null> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (!user) return null;

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) return null;

    return { id: user.id, email: user.email, name: user.name };
  }

  async login(user: UserPayload): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    const accessToken = this.issueAccessToken(user);
    const refreshToken = await this.issueRefreshToken(user.id);
    return { accessToken, refreshToken };
  }

  async refresh(rawRefreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    const tokenHash = hashRefreshToken(rawRefreshToken);

    const result = await this.prisma.$transaction(async (tx) => {
      // SHA-256 is deterministic → direct DB lookup by hash
      const stored = await tx.refreshToken.findUnique({
        where: { tokenHash },
        include: { user: true },
      });

      if (!stored || stored.revokedAt !== null || stored.expiresAt <= new Date()) {
        throw new UnauthorizedException('Refresh token inválido ou expirado.');
      }

      // Single-use rotation: revoke old, issue new (Pitfall 5)
      await tx.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      });

      const newRaw = crypto.randomUUID();
      const newHash = hashRefreshToken(newRaw);
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await tx.refreshToken.create({
        data: {
          userId: stored.userId,
          tokenHash: newHash,
          expiresAt,
        },
      });

      return { user: stored.user, newRaw };
    });

    const userPayload: UserPayload = {
      id: result.user.id,
      email: result.user.email,
      name: result.user.name,
    };

    return {
      accessToken: this.issueAccessToken(userPayload),
      refreshToken: result.newRaw,
    };
  }

  async logout(userId: string): Promise<void> {
    // Revoke all refresh tokens for this user
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private issueAccessToken(user: UserPayload): string {
    return this.jwtService.sign(
      { sub: user.id, email: user.email, name: user.name },
      {
        secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
        expiresIn: '15m',
      },
    );
  }

  private async issueRefreshToken(userId: string): Promise<string> {
    const raw = crypto.randomUUID();
    const tokenHash = hashRefreshToken(raw);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await this.prisma.refreshToken.create({
      data: { userId, tokenHash, expiresAt },
    });

    return raw;
  }
}
