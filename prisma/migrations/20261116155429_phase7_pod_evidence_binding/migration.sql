-- AlterTable
ALTER TABLE "app"."ProofOfDelivery" ADD COLUMN     "photoEvidenceHash" TEXT,
ADD COLUMN     "signatureEvidenceHash" TEXT;

-- CreateTable
CREATE TABLE "app"."DeliveryEvidenceBinding" (
    "id" TEXT NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "evidenceKind" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "proofOfDeliveryId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryEvidenceBinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryEvidenceBinding_evidenceHash_key" ON "app"."DeliveryEvidenceBinding"("evidenceHash");

-- CreateIndex
CREATE INDEX "DeliveryEvidenceBinding_packageId_idx" ON "app"."DeliveryEvidenceBinding"("packageId");

-- AddForeignKey
ALTER TABLE "app"."DeliveryEvidenceBinding" ADD CONSTRAINT "DeliveryEvidenceBinding_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "app"."Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."DeliveryEvidenceBinding" ADD CONSTRAINT "DeliveryEvidenceBinding_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "app"."DeliveryAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."DeliveryEvidenceBinding" ADD CONSTRAINT "DeliveryEvidenceBinding_proofOfDeliveryId_fkey" FOREIGN KEY ("proofOfDeliveryId") REFERENCES "app"."ProofOfDelivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."DeliveryEvidenceBinding" ADD CONSTRAINT "DeliveryEvidenceBinding_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "app"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

