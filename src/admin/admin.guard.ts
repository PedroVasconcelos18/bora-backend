import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

/**
 * Env-secret gate for the /admin refund queue (D-11, T-02-20).
 *
 * No user-role system exists yet — a single shared secret is sufficient for
 * the single-operator V1. Implements CanActivate directly (unlike
 * JwtAuthGuard, there is no Passport strategy involved): reads the
 * X-Admin-Secret request header and compares it against ConfigService's
 * ADMIN_SECRET using crypto.timingSafeEqual over equal-length buffers —
 * never `===` on a secret-derived value (T-02-22, mirrors
 * verify-signature.util.ts's HMAC comparison).
 *
 * Fails closed in every ambiguous case: a missing/empty header, a
 * length-mismatched or wrong secret, or an unconfigured/empty ADMIN_SECRET
 * all return false (NestJS turns a `false` CanActivate result into a 403).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers['x-admin-secret'];
    const secret = this.config.get<string>('ADMIN_SECRET') ?? '';

    if (!secret) {
      // ADMIN_SECRET not configured — fail closed regardless of what was sent.
      return false;
    }

    if (typeof provided !== 'string' || !provided) {
      return false;
    }

    const providedBuf = Buffer.from(provided);
    const secretBuf = Buffer.from(secret);

    if (providedBuf.length !== secretBuf.length) {
      return false;
    }

    return timingSafeEqual(providedBuf, secretBuf);
  }
}
