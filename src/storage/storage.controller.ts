import { Controller, Get, Logger, Param, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createReadStream, createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { LocalStorageAdapter } from './adapters/local-storage.adapter';
import { ALLOWED_IMAGE_CONTENT_TYPES, MAX_UPLOAD_BYTES } from './storage.constants';

/**
 * StorageController — the V1 local ephemeral store's transport (design pivot,
 * 2026-07-09). Deliberately routes evidence bytes THROUGH NestJS, which
 * CLAUDE.md's committed stack advises against (it recommends presigned-direct
 * upload and warns off Multer). This is a conscious V1 tradeoff: photos are
 * ephemeral (deleted after 24h), the friend-group scale is tiny, and the whole
 * flow sits behind the IObjectStorage interface so swapping back to
 * presigned-direct-to-R2 is an adapter change, not a rewrite. Multer is NOT
 * used — the raw request body is streamed straight to disk.
 *
 * No JwtAuthGuard: PUT is authorized by the HMAC signature on the presigned
 * URL (mirroring R2's presigned-PUT model — the signature IS the auth); GET is
 * public by design (A1 — closed friend group, unguessable structured keys).
 */
@Controller()
export class StorageController {
  private readonly logger = new Logger(StorageController.name);

  constructor(private readonly local: LocalStorageAdapter) {}

  /** PUT /storage/:key — signed, size- and type-capped raw upload to disk. */
  @Put('storage/:key')
  async put(
    @Param('key') keyParam: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const key = decodeURIComponent(keyParam);

    if (!exp || !sig || this.local.isExpired(exp) || !this.local.verifyUploadSignature(key, exp, sig)) {
      res.status(403).json({ message: 'Assinatura de upload inválida ou expirada.' });
      return;
    }

    const contentType = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim();
    if (!ALLOWED_IMAGE_CONTENT_TYPES.includes(contentType as (typeof ALLOWED_IMAGE_CONTENT_TYPES)[number])) {
      res.status(415).json({ message: 'Tipo de arquivo não suportado.' });
      return;
    }

    let target: string;
    try {
      target = this.local.resolvePath(key);
    } catch {
      res.status(403).json({ message: 'Chave de objeto inválida.' });
      return;
    }

    try {
      await this.streamToFile(req, target);
    } catch (err) {
      if ((err as { tooLarge?: boolean })?.tooLarge) {
        res.status(413).json({ message: 'Arquivo muito grande.' });
        return;
      }
      this.logger.error(
        `PUT /storage: failed to persist ${key}: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }`,
      );
      res.status(500).json({ message: 'Falha ao salvar o arquivo.' });
      return;
    }

    // Sidecar records the content-type so GET can serve it faithfully (the key
    // is always .jpg but the bytes may be png/webp). Cleanup cron reaps both
    // the object and its sidecar by mtime.
    await fs.writeFile(`${target}.ct`, contentType, 'utf8');

    res.status(201).json({ ok: true, key });
  }

  /** GET /storage/:key — public read, streams the stored bytes with their content-type. */
  @Get('storage/:key')
  async get(@Param('key') keyParam: string, @Res() res: Response): Promise<void> {
    const key = decodeURIComponent(keyParam);

    let target: string;
    try {
      target = this.local.resolvePath(key);
    } catch {
      res.status(403).end();
      return;
    }

    try {
      await fs.access(target);
    } catch {
      res.status(404).json({ message: 'Evidência não encontrada.' });
      return;
    }

    let contentType = 'image/jpeg';
    try {
      const stored = (await fs.readFile(`${target}.ct`, 'utf8')).trim();
      if (stored) contentType = stored;
    } catch {
      // no sidecar — fall back to image/jpeg (keys are always .jpg)
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    createReadStream(target).pipe(res);
  }

  /**
   * Streams the raw request body to `finalPath` via a temp file + atomic
   * rename, enforcing MAX_UPLOAD_BYTES mid-stream. The global JSON/urlencoded
   * body parsers are content-type gated (application/json, x-www-form-
   * urlencoded), so an image/* body is never consumed upstream — the raw
   * stream is intact here. No Multer, no full-buffer-in-memory.
   */
  private streamToFile(req: Request, finalPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tmp = `${finalPath}.tmp-${randomUUID()}`;
      let bytes = 0;
      let settled = false;

      const finish = (err?: unknown) => {
        if (settled) return;
        settled = true;
        if (err) {
          ws.destroy();
          void fs.unlink(tmp).catch(() => undefined);
          reject(err);
        } else {
          resolve();
        }
      };

      const ensureDir = fs.mkdir(path.dirname(finalPath), { recursive: true });
      let ws: ReturnType<typeof createWriteStream>;

      ensureDir
        .then(() => {
          ws = createWriteStream(tmp);
          ws.on('error', finish);
          ws.on('finish', () => {
            fs.rename(tmp, finalPath).then(() => finish(), finish);
          });

          req.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_UPLOAD_BYTES) {
              req.unpipe(ws);
              const e = new Error('payload too large') as Error & { tooLarge: boolean };
              e.tooLarge = true;
              finish(e);
            }
          });
          req.on('error', finish);
          req.pipe(ws);
        })
        .catch(finish);
    });
  }
}
