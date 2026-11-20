-- Outlook email intake

-- CreateEnum
CREATE TYPE "RecordSource" AS ENUM ('UPLOAD', 'EMAIL');

-- CreateEnum
CREATE TYPE "IntakeOutcome" AS ENUM ('IMPORTING', 'IMPORTED', 'NO_PDF', 'SENDER_NOT_ALLOWED', 'FAILED');

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'EMAIL_PO_RECEIVED';

-- AlterTable
ALTER TABLE "PORecord" ADD COLUMN "source" "RecordSource" NOT NULL DEFAULT 'UPLOAD',
ADD COLUMN "intakeEmailId" TEXT;

-- CreateTable
CREATE TABLE "IntakeEmail" (
    "id" TEXT NOT NULL,
    "internetMessageId" TEXT NOT NULL,
    "graphMessageId" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "subject" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "outcome" "IntakeOutcome" NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntakeEmail_internetMessageId_key" ON "IntakeEmail"("internetMessageId");

-- CreateIndex
CREATE INDEX "IntakeEmail_createdAt_idx" ON "IntakeEmail"("createdAt");

-- AddForeignKey
ALTER TABLE "PORecord" ADD CONSTRAINT "PORecord_intakeEmailId_fkey" FOREIGN KEY ("intakeEmailId") REFERENCES "IntakeEmail"("id") ON DELETE SET NULL ON UPDATE CASCADE;
