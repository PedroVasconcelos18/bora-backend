import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Behind the Railway edge proxy, req.ip reflects the proxy's internal socket
 * IP, not the real client IP — every request would be counted as a single
 * "IP" and the rate limit would become a global counter shared by all users.
 *
 * With `trust proxy` set (see main.ts), Express populates req.ips from
 * X-Forwarded-For. This guard reads the real client IP from there.
 */
@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.ips?.length ? req.ips[0] : req.ip;
  }
}
