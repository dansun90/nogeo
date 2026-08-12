-- AlterTable
ALTER TABLE "User" ADD COLUMN     "monthlyCreditsRemaining" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "purchasedCreditsRemaining" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stripeCustomerId" TEXT,
ADD COLUMN     "subscriptionStatus" TEXT NOT NULL DEFAULT 'free';
