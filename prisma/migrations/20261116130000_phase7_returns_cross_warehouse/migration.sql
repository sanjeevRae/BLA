-- Phase 7 (cross-warehouse returns, return-workflow §3 steps 4–6):
-- a return first received at the delivery warehouse may have to
-- travel on a normal transfer to the RETURN warehouse (the origin
-- warehouse of the package's shipment), where inspection and vendor
-- handover happen. `destinationWarehouseId` records that return
-- warehouse; `transferId` links the transfer carrying the return.

-- AlterTable
ALTER TABLE "ReturnRequest" ADD COLUMN     "destinationWarehouseId" TEXT,
ADD COLUMN     "transferId" TEXT;

-- Backfill: existing returns are same-warehouse returns — the
-- warehouse that received them is also their return warehouse.
UPDATE "ReturnRequest" SET "destinationWarehouseId" = "warehouseId" WHERE "destinationWarehouseId" IS NULL;

-- CreateIndex
CREATE INDEX "ReturnRequest_destinationWarehouseId_status_idx" ON "ReturnRequest"("destinationWarehouseId", "status");

-- CreateIndex
CREATE INDEX "ReturnRequest_transferId_idx" ON "ReturnRequest"("transferId");

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_destinationWarehouseId_fkey" FOREIGN KEY ("destinationWarehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
