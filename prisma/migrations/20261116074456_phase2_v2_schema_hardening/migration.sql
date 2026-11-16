-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "requestFingerprint" TEXT;

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "PackageItem_packageId_idx" ON "PackageItem"("packageId");

-- CreateIndex
CREATE INDEX "PackageItem_orderItemId_idx" ON "PackageItem"("orderItemId");

-- CreateIndex
CREATE INDEX "PackageLabel_packageId_idx" ON "PackageLabel"("packageId");
