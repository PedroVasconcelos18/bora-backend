-- AlterTable
ALTER TABLE "users" ADD COLUMN     "pix_keys" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill: a chave Pix única existente vira o primeiro item da nova lista
-- (nada se perde na migração para múltiplas chaves).
UPDATE "users"
SET "pix_keys" = ARRAY["pix_key"]
WHERE "pix_key" IS NOT NULL AND btrim("pix_key") <> '' AND cardinality("pix_keys") = 0;
