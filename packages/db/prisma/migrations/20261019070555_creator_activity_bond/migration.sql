-- AlterTable
ALTER TABLE "KeyMarket" ADD COLUMN     "creatorInactive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "creatorInactiveSince" TIMESTAMP(3);

