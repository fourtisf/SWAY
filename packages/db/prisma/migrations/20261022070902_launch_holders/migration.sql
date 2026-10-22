-- AlterTable
ALTER TABLE "LaunchToken" ADD COLUMN     "holders" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "holdersBlock" BIGINT;

-- CreateTable
CREATE TABLE "LaunchHolder" (
    "launchTokenId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "balance" DECIMAL(78,0) NOT NULL,

    CONSTRAINT "LaunchHolder_pkey" PRIMARY KEY ("launchTokenId","address")
);

-- AddForeignKey
ALTER TABLE "LaunchHolder" ADD CONSTRAINT "LaunchHolder_launchTokenId_fkey" FOREIGN KEY ("launchTokenId") REFERENCES "LaunchToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;
