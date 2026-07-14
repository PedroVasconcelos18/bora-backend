-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'APPROVED', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED', 'PAYOUT_PENDING', 'PAID_OUT');

-- CreateEnum
CREATE TYPE "EvidenceStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "VoteValue" AS ENUM ('SIM', 'NAO');

-- AlterTable
ALTER TABLE "challenges" ADD COLUMN     "starts_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "participants" ADD COLUMN     "pix_key" TEXT;

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "external_id" TEXT,
    "participant_id" TEXT NOT NULL,
    "challenge_id" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "raw_webhook_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "pix_key" TEXT,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidences" (
    "id" TEXT NOT NULL,
    "challenge_id" TEXT NOT NULL,
    "participant_id" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "evidence_date" TEXT NOT NULL,
    "status" "EvidenceStatus" NOT NULL DEFAULT 'PENDING',
    "window_closes_at" TIMESTAMP(3) NOT NULL,
    "posted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "evidences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "votes" (
    "id" TEXT NOT NULL,
    "evidence_id" TEXT NOT NULL,
    "voter_id" TEXT NOT NULL,
    "value" "VoteValue" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "votes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_external_id_key" ON "payments"("external_id");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX "evidences_status_window_closes_at_idx" ON "evidences"("status", "window_closes_at");

-- CreateIndex
CREATE UNIQUE INDEX "evidences_participant_id_evidence_date_key" ON "evidences"("participant_id", "evidence_date");

-- CreateIndex
CREATE UNIQUE INDEX "votes_evidence_id_voter_id_key" ON "votes"("evidence_id", "voter_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "challenges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidences" ADD CONSTRAINT "evidences_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "challenges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidences" ADD CONSTRAINT "evidences_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votes" ADD CONSTRAINT "votes_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votes" ADD CONSTRAINT "votes_voter_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

