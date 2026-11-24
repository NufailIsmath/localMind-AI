-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('ANNUAL', 'SICK', 'PARENTAL', 'UNPAID', 'OTHER');

-- CreateEnum
CREATE TYPE "LeaveEntryStatus" AS ENUM ('APPROVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LeaveEntrySource" AS ENUM ('MANUAL', 'IMPORT');

-- CreateTable
CREATE TABLE "LeaveAllowance" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "leaveType" "LeaveType" NOT NULL,
    "entitledHalfDays" INTEGER NOT NULL,
    "carriedHalfDays" INTEGER NOT NULL DEFAULT 0,
    "carryOverExpiresOn" DATE,
    "adjustmentHalfDays" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaveAllowance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveEntry" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "leaveType" "LeaveType" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "halfDays" INTEGER NOT NULL,
    "status" "LeaveEntryStatus" NOT NULL DEFAULT 'APPROVED',
    "source" "LeaveEntrySource" NOT NULL DEFAULT 'MANUAL',
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyHoliday" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "CompanyHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeaveAllowance_userId_year_leaveType_key" ON "LeaveAllowance"("userId", "year", "leaveType");

-- CreateIndex
CREATE INDEX "LeaveEntry_userId_startDate_idx" ON "LeaveEntry"("userId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyHoliday_date_key" ON "CompanyHoliday"("date");

-- AddForeignKey
ALTER TABLE "LeaveAllowance" ADD CONSTRAINT "LeaveAllowance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveEntry" ADD CONSTRAINT "LeaveEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
