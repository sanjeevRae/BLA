-- CreateTable
CREATE TABLE "TrackingSession" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "tripId" TEXT,
    "deliveryBatchId" TEXT,
    "trackingType" TEXT NOT NULL,
    "originWarehouseId" TEXT NOT NULL,
    "destinationWarehouseId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "startReason" TEXT NOT NULL,
    "endReason" TEXT,
    "permissionAcknowledgedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverLocationPing" (
    "id" TEXT NOT NULL,
    "trackingSessionId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracyMeters" DOUBLE PRECISION NOT NULL,
    "speedMetersPerSecond" DOUBLE PRECISION,
    "headingDegrees" DOUBLE PRECISION,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sequenceId" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'BROWSER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverLocationPing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverCurrentLocation" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "trackingSessionId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracyMeters" DOUBLE PRECISION NOT NULL,
    "lastRecordedAt" TIMESTAMP(3) NOT NULL,
    "lastReceivedAt" TIMESTAMP(3) NOT NULL,
    "freshnessState" TEXT NOT NULL DEFAULT 'FRESH',
    "activeTripId" TEXT,
    "activeBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriverCurrentLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrackingSession_driverId_status_idx" ON "TrackingSession"("driverId", "status");

-- CreateIndex
CREATE INDEX "TrackingSession_tripId_idx" ON "TrackingSession"("tripId");

-- CreateIndex
CREATE INDEX "TrackingSession_deliveryBatchId_idx" ON "TrackingSession"("deliveryBatchId");

-- CreateIndex
CREATE INDEX "TrackingSession_originWarehouseId_status_idx" ON "TrackingSession"("originWarehouseId", "status");

-- CreateIndex
CREATE INDEX "TrackingSession_destinationWarehouseId_status_idx" ON "TrackingSession"("destinationWarehouseId", "status");

-- CreateIndex
CREATE INDEX "DriverLocationPing_trackingSessionId_recordedAt_idx" ON "DriverLocationPing"("trackingSessionId", "recordedAt" DESC);

-- CreateIndex
CREATE INDEX "DriverLocationPing_driverId_receivedAt_idx" ON "DriverLocationPing"("driverId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DriverLocationPing_trackingSessionId_sequenceId_key" ON "DriverLocationPing"("trackingSessionId", "sequenceId");

-- CreateIndex
CREATE UNIQUE INDEX "DriverCurrentLocation_driverId_key" ON "DriverCurrentLocation"("driverId");

-- AddForeignKey
ALTER TABLE "TrackingSession" ADD CONSTRAINT "TrackingSession_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingSession" ADD CONSTRAINT "TrackingSession_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingSession" ADD CONSTRAINT "TrackingSession_deliveryBatchId_fkey" FOREIGN KEY ("deliveryBatchId") REFERENCES "DeliveryBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingSession" ADD CONSTRAINT "TrackingSession_originWarehouseId_fkey" FOREIGN KEY ("originWarehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingSession" ADD CONSTRAINT "TrackingSession_destinationWarehouseId_fkey" FOREIGN KEY ("destinationWarehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverLocationPing" ADD CONSTRAINT "DriverLocationPing_trackingSessionId_fkey" FOREIGN KEY ("trackingSessionId") REFERENCES "TrackingSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverLocationPing" ADD CONSTRAINT "DriverLocationPing_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverCurrentLocation" ADD CONSTRAINT "DriverCurrentLocation_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverCurrentLocation" ADD CONSTRAINT "DriverCurrentLocation_trackingSessionId_fkey" FOREIGN KEY ("trackingSessionId") REFERENCES "TrackingSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverCurrentLocation" ADD CONSTRAINT "DriverCurrentLocation_activeTripId_fkey" FOREIGN KEY ("activeTripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverCurrentLocation" ADD CONSTRAINT "DriverCurrentLocation_activeBatchId_fkey" FOREIGN KEY ("activeBatchId") REFERENCES "DeliveryBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
