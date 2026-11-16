-- CreateTable
CREATE TABLE "InvitationAttempt" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "succeeded" BOOLEAN NOT NULL DEFAULT false,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvitationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvitationAttempt_ipAddress_createdAt_idx" ON "InvitationAttempt"("ipAddress", "createdAt");

-- CreateIndex
CREATE INDEX "InvitationAttempt_tokenHash_createdAt_idx" ON "InvitationAttempt"("tokenHash", "createdAt");
