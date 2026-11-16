-- Phase 3 (V2) GPS hardening (hand-written, following the Phase 4/6
-- pattern): vocabulary CHECK constraints, the exactly-one-assignment
-- and type-consistency CHECKs, the ended-shape CHECK, coordinate /
-- accuracy range CHECKs, and the one-active-session-per-driver
-- partial unique index (Prisma cannot express partial indexes).
-- The vocabulary values here are mirrored in
-- src/lib/tracking/domain.ts — the database and that module are the
-- two halves of the same contract.

-- TrackingSession ------------------------------------------------------------
ALTER TABLE "app"."TrackingSession"
  ADD CONSTRAINT "TrackingSession_trackingType_check"
    CHECK ("trackingType" IN ('LINEHAUL', 'PICKUP', 'DELIVERY')),
  ADD CONSTRAINT "TrackingSession_status_check"
    CHECK ("status" IN ('ACTIVE', 'PAUSED', 'ENDED')),
  ADD CONSTRAINT "TrackingSession_assignment_shape_check"
    CHECK (("tripId" IS NOT NULL) <> ("deliveryBatchId" IS NOT NULL)),
  ADD CONSTRAINT "TrackingSession_type_assignment_check"
    CHECK (
      ("trackingType" = 'LINEHAUL' AND "tripId" IS NOT NULL)
      OR ("trackingType" IN ('PICKUP', 'DELIVERY') AND "deliveryBatchId" IS NOT NULL)
    ),
  ADD CONSTRAINT "TrackingSession_startReason_check"
    CHECK ("startReason" IN ('DRIVER')),
  ADD CONSTRAINT "TrackingSession_endReason_check"
    CHECK ("endReason" IS NULL OR "endReason" IN ('DRIVER', 'SUPERVISOR', 'ASSIGNMENT_COMPLETED', 'ASSIGNMENT_CANCELLED', 'EXPIRED')),
  ADD CONSTRAINT "TrackingSession_ended_shape_check"
    CHECK (("status" = 'ENDED') = ("endedAt" IS NOT NULL));

-- One ACTIVE tracking session per driver, ever (duplicate-start guard).
CREATE UNIQUE INDEX "TrackingSession_one_active_per_driver"
  ON "app"."TrackingSession" ("driverId") WHERE "status" = 'ACTIVE';

-- DriverLocationPing ---------------------------------------------------------
ALTER TABLE "app"."DriverLocationPing"
  ADD CONSTRAINT "DriverLocationPing_latitude_check"
    CHECK ("latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "DriverLocationPing_longitude_check"
    CHECK ("longitude" BETWEEN -180 AND 180),
  ADD CONSTRAINT "DriverLocationPing_accuracyMeters_check"
    CHECK ("accuracyMeters" > 0 AND "accuracyMeters" <= 100000),
  ADD CONSTRAINT "DriverLocationPing_source_check"
    CHECK ("source" IN ('BROWSER')),
  ADD CONSTRAINT "DriverLocationPing_sequenceId_check"
    CHECK ("sequenceId" >= 0),
  ADD CONSTRAINT "DriverLocationPing_speed_check"
    CHECK ("speedMetersPerSecond" IS NULL OR "speedMetersPerSecond" >= 0),
  ADD CONSTRAINT "DriverLocationPing_heading_check"
    CHECK ("headingDegrees" IS NULL OR ("headingDegrees" BETWEEN 0 AND 360));

-- DriverCurrentLocation ------------------------------------------------------
ALTER TABLE "app"."DriverCurrentLocation"
  ADD CONSTRAINT "DriverCurrentLocation_latitude_check"
    CHECK ("latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "DriverCurrentLocation_longitude_check"
    CHECK ("longitude" BETWEEN -180 AND 180),
  ADD CONSTRAINT "DriverCurrentLocation_accuracyMeters_check"
    CHECK ("accuracyMeters" > 0),
  ADD CONSTRAINT "DriverCurrentLocation_freshnessState_check"
    CHECK ("freshnessState" IN ('FRESH', 'DELAYED', 'STALE', 'OFFLINE'));
