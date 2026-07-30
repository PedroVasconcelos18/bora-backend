-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "qr_code" TEXT,
ADD COLUMN     "qr_code_base64" TEXT,
ADD COLUMN     "ticket_url" TEXT;
