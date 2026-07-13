import {
  Controller,
  Post,
  Delete,
  Get,
  Body,
  Param,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response, Request } from 'express';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { SignupDto } from './dto/signup.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ThrottlerBehindProxyGuard } from './guards/throttler-behind-proxy.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserPayload } from './strategies/jwt.strategy';

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private passwordResetService: PasswordResetService,
  ) {}

  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  async signup(
    @Body() dto: SignupDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.authService.signup(dto);
    const { accessToken, refreshToken } = await this.authService.login(user);
    this.setAuthCookies(res, accessToken, refreshToken);
    return { user };
  }

  @Post('login')
  @UseGuards(LocalAuthGuard)
  @HttpCode(HttpStatus.OK)
  async login(
    @CurrentUser() user: UserPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken } = await this.authService.login(user);
    this.setAuthCookies(res, accessToken, refreshToken);
    return { user };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rawRefreshToken: string | undefined = req.cookies?.refresh_token;
    if (!rawRefreshToken) {
      throw new UnauthorizedException('Refresh token não encontrado.');
    }

    const { accessToken, refreshToken } =
      await this.authService.refresh(rawRefreshToken);
    this.setAuthCookies(res, accessToken, refreshToken);
    return { message: 'Token renovado.' };
  }

  @Delete('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser() user: UserPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logout(user.id);
    this.clearAuthCookies(res);
    return { message: 'Sessão encerrada.' };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: UserPayload) {
    return { user };
  }

  // ─── recuperar senha (PWD-01/PWD-02) ─────────────────────────────────────────
  // Public routes — the visitor is, by definition, logged out. No auth guard on
  // any of the 3 handlers below (precedent: GET /invites/:token). Only a
  // throttle guard, applied per-method, never at the @Controller level — login
  // and signup live in this same controller and must stay unthrottled (D-07).

  /**
   * POST /auth/forgot-password
   * Always 200 with the same body, whether or not the account exists (D-06) —
   * the handler must never derive status/body from the service's result.
   */
  @Post('forgot-password')
  @UseGuards(ThrottlerBehindProxyGuard)
  @Throttle({ 'password-reset': { limit: 5, ttl: 900_000 } }) // 5 req / 15 min por IP
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.passwordResetService.requestPasswordReset(dto.email);
    return {
      message: 'Se essa conta existir, o link de recuperação foi enviado.',
    };
  }

  /**
   * GET /auth/reset-password/:token
   * Always 200 — a bad token is { valid: false }, never a 404/401.
   */
  @Get('reset-password/:token')
  @UseGuards(ThrottlerBehindProxyGuard)
  @Throttle({ 'password-reset': { limit: 20, ttl: 900_000 } }) // 20 req / 15 min por IP
  async validateResetToken(@Param('token') token: string) {
    return this.passwordResetService.validateResetToken(token);
  }

  /**
   * POST /auth/reset-password
   * Dead token (invalid/expired/used) throws BadRequestException (400) from
   * the service — never 401 (see api_contract in the plan for why).
   */
  @Post('reset-password')
  @UseGuards(ThrottlerBehindProxyGuard)
  @Throttle({ 'password-reset': { limit: 10, ttl: 900_000 } }) // 10 req / 15 min por IP
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.passwordResetService.resetPassword(dto.token, dto.password);
    return { ok: true };
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  private get cookieOptions() {
    const isProd = process.env.NODE_ENV === 'production';
    return {
      httpOnly: true,
      secure: isProd,
      // SameSite=Lax for cross-subdomain (app.* ↔ api.* share parent .borajuntos.app)
      // SameSite=Strict for local dev (both on localhost)
      sameSite: (isProd ? 'lax' : 'strict') as 'lax' | 'strict',
      // domain only in production — undefined in local dev avoids localhost mismatch
      domain: isProd ? process.env.COOKIE_DOMAIN : undefined,
    };
  }

  private setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
    const base = this.cookieOptions;

    res.cookie('access_token', accessToken, {
      ...base,
      maxAge: 15 * 60 * 1000, // 15 minutes
    });

    res.cookie('refresh_token', refreshToken, {
      ...base,
      path: '/auth/refresh', // scoped to refresh endpoint only
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });
  }

  private clearAuthCookies(res: Response) {
    const base = this.cookieOptions;
    res.clearCookie('access_token', base);
    res.clearCookie('refresh_token', {
      ...base,
      path: '/auth/refresh',
    });
  }
}
