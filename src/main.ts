import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Trust exactly 1 hop (the Railway edge proxy) so req.ips is populated from
  // X-Forwarded-For without letting a client spoof extra hops to dodge
  // rate limiting (ThrottlerBehindProxyGuard reads req.ips[0]).
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // cookie-parser MUST come before passport middleware and route handlers
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // CORS — explicit origin required when credentials: true (never use '*' with credentials)
  app.enableCors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Secret'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Application listening on port ${port}`);
}

bootstrap();
