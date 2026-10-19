-- AlterEnum
ALTER TYPE "PointsKind" ADD VALUE 'streak';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "notifPrefs" JSONB,
ADD COLUMN     "streakDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "streakLastDay" TEXT;

-- CreateTable
CREATE TABLE "Watch" (
    "userId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "alertPct" INTEGER NOT NULL DEFAULT 10,
    "baselineWei" DECIMAL(78,0) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Watch_pkey" PRIMARY KEY ("userId","subjectId")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lastOkAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DropPlan" (
    "root" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "totalWei" DECIMAL(78,0) NOT NULL,
    "holders" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DropPlan_pkey" PRIMARY KEY ("root")
);

-- CreateTable
CREATE TABLE "DropAllocation" (
    "root" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "userId" TEXT,
    "amountWei" DECIMAL(78,0) NOT NULL,
    "proof" JSONB NOT NULL,
    "claimTx" TEXT,
    "claimBlock" BIGINT,

    CONSTRAINT "DropAllocation_pkey" PRIMARY KEY ("root","address")
);

-- CreateTable
CREATE TABLE "CreatorDrop" (
    "id" INTEGER NOT NULL,
    "creator" TEXT NOT NULL,
    "root" TEXT NOT NULL,
    "totalWei" DECIMAL(78,0) NOT NULL,
    "claimedWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "reclaimed" BOOLEAN NOT NULL DEFAULT false,
    "txHash" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorDrop_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Watch_subjectId_idx" ON "Watch"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE INDEX "DropPlan_creatorId_createdAt_idx" ON "DropPlan"("creatorId", "createdAt");

-- CreateIndex
CREATE INDEX "DropAllocation_address_idx" ON "DropAllocation"("address");

-- CreateIndex
CREATE INDEX "CreatorDrop_root_idx" ON "CreatorDrop"("root");

-- CreateIndex
CREATE INDEX "CreatorDrop_creator_idx" ON "CreatorDrop"("creator");

-- AddForeignKey
ALTER TABLE "Watch" ADD CONSTRAINT "Watch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Watch" ADD CONSTRAINT "Watch_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DropPlan" ADD CONSTRAINT "DropPlan_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DropAllocation" ADD CONSTRAINT "DropAllocation_root_fkey" FOREIGN KEY ("root") REFERENCES "DropPlan"("root") ON DELETE CASCADE ON UPDATE CASCADE;

