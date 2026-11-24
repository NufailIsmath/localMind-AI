-- CreateEnum
CREATE TYPE "HrSyncStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "LeaveEntry" ADD COLUMN     "externalId" TEXT;

-- CreateTable
CREATE TABLE "HrSyncEvent" (
    "id" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "HrSyncStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrSyncEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HrSyncEvent_status_nextAttemptAt_idx" ON "HrSyncEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "HrSyncEvent_entryId_createdAt_idx" ON "HrSyncEvent"("entryId", "createdAt");
