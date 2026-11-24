-- AlterEnum
ALTER TYPE "LeaveEntrySource" ADD VALUE 'REQUEST';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LeaveEntryStatus" ADD VALUE 'PENDING';
ALTER TYPE "LeaveEntryStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "LeaveEntry" ADD COLUMN     "actionRef" TEXT,
ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decidedById" UUID,
ADD COLUMN     "decisionNote" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "actions" JSONB;

-- CreateIndex
CREATE INDEX "LeaveEntry_status_startDate_idx" ON "LeaveEntry"("status", "startDate");
