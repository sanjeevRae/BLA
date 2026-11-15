-- AlterTable
ALTER TABLE "TrackingEvent" ADD COLUMN     "deliveryAssignmentId" TEXT;

-- CreateTable
CREATE TABLE "DeliveryBatch" (
    "id" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "serviceAreaId" TEXT,
    "batchDate" DATE NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'DELIVERY',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryAssignment" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "batchId" TEXT,
    "vehicleId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'DELIVERY',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "assignedById" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "routeSequence" INTEGER,
    "deliveryInstructions" TEXT,
    "failureNote" TEXT,
    "reassignedFromId" TEXT,
    "otpCodeHash" TEXT,
    "otpGeneratedAt" TIMESTAMP(3),
    "otpExpiresAt" TIMESTAMP(3),
    "otpFailedAttempts" INTEGER NOT NULL DEFAULT 0,
    "otpLockedAt" TIMESTAMP(3),
    "otpVerifiedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryAttempt" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "result" TEXT NOT NULL,
    "failureReason" TEXT,
    "contactOutcome" TEXT,
    "evidenceFileId" TEXT,
    "nextAction" TEXT NOT NULL DEFAULT 'NONE',
    "notes" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProofOfDelivery" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "attemptId" TEXT,
    "method" TEXT NOT NULL DEFAULT 'OTP',
    "receivedByName" TEXT,
    "relationshipToRecipient" TEXT,
    "otpCodeHash" TEXT,
    "otpExpiresAt" TIMESTAMP(3),
    "otpVerifiedAt" TIMESTAMP(3),
    "signatureFileId" TEXT,
    "photoFileId" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "deliveredAt" TIMESTAMP(3) NOT NULL,
    "recordedById" TEXT NOT NULL,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProofOfDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryCodCollection" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "batchId" TEXT,
    "expectedPaisa" BIGINT NOT NULL,
    "collectedPaisa" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'CASH',
    "collectedById" TEXT NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryCodCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnRequest" (
    "id" TEXT NOT NULL,
    "returnNumber" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedById" TEXT NOT NULL,
    "authorisedById" TEXT,
    "authorisedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "chargeBearer" TEXT,
    "chargeAmountPaisa" BIGINT NOT NULL DEFAULT 0,
    "conditionAtInitiation" TEXT NOT NULL DEFAULT 'GOOD',
    "conditionAtInspection" TEXT,
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "inspectedById" TEXT,
    "inspectedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "handedToUserId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingAccessAttempt" (
    "id" TEXT NOT NULL,
    "trackingId" TEXT NOT NULL,
    "phoneHash" TEXT NOT NULL,
    "succeeded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingAccessAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryBatch_riderId_batchDate_idx" ON "DeliveryBatch"("riderId", "batchDate");

-- CreateIndex
CREATE INDEX "DeliveryBatch_warehouseId_status_idx" ON "DeliveryBatch"("warehouseId", "status");

-- CreateIndex
CREATE INDEX "DeliveryAssignment_driverId_status_idx" ON "DeliveryAssignment"("driverId", "status");

-- CreateIndex
CREATE INDEX "DeliveryAssignment_packageId_status_idx" ON "DeliveryAssignment"("packageId", "status");

-- CreateIndex
CREATE INDEX "DeliveryAssignment_batchId_idx" ON "DeliveryAssignment"("batchId");

-- CreateIndex
CREATE INDEX "DeliveryAttempt_packageId_attemptedAt_idx" ON "DeliveryAttempt"("packageId", "attemptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryAttempt_assignmentId_attemptNumber_key" ON "DeliveryAttempt"("assignmentId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ProofOfDelivery_attemptId_key" ON "ProofOfDelivery"("attemptId");

-- CreateIndex
CREATE INDEX "ProofOfDelivery_packageId_idx" ON "ProofOfDelivery"("packageId");

-- CreateIndex
CREATE INDEX "ProofOfDelivery_assignmentId_idx" ON "ProofOfDelivery"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryCodCollection_packageId_key" ON "DeliveryCodCollection"("packageId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryCodCollection_assignmentId_key" ON "DeliveryCodCollection"("assignmentId");

-- CreateIndex
CREATE INDEX "DeliveryCodCollection_collectedById_collectedAt_idx" ON "DeliveryCodCollection"("collectedById", "collectedAt");

-- CreateIndex
CREATE INDEX "DeliveryCodCollection_batchId_idx" ON "DeliveryCodCollection"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnRequest_returnNumber_key" ON "ReturnRequest"("returnNumber");

-- CreateIndex
CREATE INDEX "ReturnRequest_packageId_status_idx" ON "ReturnRequest"("packageId", "status");

-- CreateIndex
CREATE INDEX "ReturnRequest_warehouseId_status_idx" ON "ReturnRequest"("warehouseId", "status");

-- CreateIndex
CREATE INDEX "ReturnRequest_shipmentId_idx" ON "ReturnRequest"("shipmentId");

-- CreateIndex
CREATE INDEX "TrackingAccessAttempt_trackingId_createdAt_idx" ON "TrackingAccessAttempt"("trackingId", "createdAt");

-- AddForeignKey
ALTER TABLE "TrackingEvent" ADD CONSTRAINT "TrackingEvent_deliveryAssignmentId_fkey" FOREIGN KEY ("deliveryAssignmentId") REFERENCES "DeliveryAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryBatch" ADD CONSTRAINT "DeliveryBatch_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryBatch" ADD CONSTRAINT "DeliveryBatch_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryBatch" ADD CONSTRAINT "DeliveryBatch_serviceAreaId_fkey" FOREIGN KEY ("serviceAreaId") REFERENCES "ServiceArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryBatch" ADD CONSTRAINT "DeliveryBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryBatch" ADD CONSTRAINT "DeliveryBatch_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "DeliveryBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAssignment" ADD CONSTRAINT "DeliveryAssignment_reassignedFromId_fkey" FOREIGN KEY ("reassignedFromId") REFERENCES "DeliveryAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAttempt" ADD CONSTRAINT "DeliveryAttempt_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "DeliveryAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAttempt" ADD CONSTRAINT "DeliveryAttempt_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAttempt" ADD CONSTRAINT "DeliveryAttempt_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProofOfDelivery" ADD CONSTRAINT "ProofOfDelivery_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProofOfDelivery" ADD CONSTRAINT "ProofOfDelivery_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "DeliveryAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProofOfDelivery" ADD CONSTRAINT "ProofOfDelivery_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "DeliveryAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProofOfDelivery" ADD CONSTRAINT "ProofOfDelivery_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProofOfDelivery" ADD CONSTRAINT "ProofOfDelivery_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "ProofOfDelivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryCodCollection" ADD CONSTRAINT "DeliveryCodCollection_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryCodCollection" ADD CONSTRAINT "DeliveryCodCollection_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryCodCollection" ADD CONSTRAINT "DeliveryCodCollection_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "DeliveryAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryCodCollection" ADD CONSTRAINT "DeliveryCodCollection_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "DeliveryBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryCodCollection" ADD CONSTRAINT "DeliveryCodCollection_collectedById_fkey" FOREIGN KEY ("collectedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_authorisedById_fkey" FOREIGN KEY ("authorisedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_inspectedById_fkey" FOREIGN KEY ("inspectedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_handedToUserId_fkey" FOREIGN KEY ("handedToUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

