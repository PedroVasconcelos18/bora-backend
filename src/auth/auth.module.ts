import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { LocalStrategy } from './strategies/local.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [
    PassportModule,
    // JwtModule configured without a default secret — each sign() call passes its own secret
    // so that access and refresh tokens can use different secrets.
    JwtModule.register({}),
    // For the password-reset email (Plan 08-03). Not imported by any v1.0 module.
    EmailModule,
    // Scoped ONLY to AuthModule — D-07 (zero regression): ThrottlerModule must
    // NEVER be imported in app.module.ts, and no v1.0 module imports AuthModule's
    // exports, so this guard is structurally unreachable from the rest of the app.
    ThrottlerModule.forRoot([
      { name: 'password-reset', ttl: 900_000, limit: 5 }, // 15 min / 5 req default
    ]),
  ],
  providers: [AuthService, LocalStrategy, JwtStrategy],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
