import {
  Controller,
  Post,
  Delete,
  Get,
  Body,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  Req,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserPayload } from './strategies/jwt.strategy';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

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
