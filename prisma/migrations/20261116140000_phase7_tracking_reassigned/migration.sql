-- Phase 7 (V2) reassignment support (hand-written, following the
-- Phase 3 GPS hardening pattern): the TrackingSession endReason
-- vocabulary gains REASSIGNED — a session ended because the batch /
-- trip it was tracking was reassigned to another rider / driver
-- (deliveries.reassignBatch, trips.replaceTripDriver). The value is
-- mirrored in src/lib/tracking/domain.ts (TRACKING_END_REASONS) —
-- the database and that module are the two halves of the same
-- contract. No Prisma schema change: endReason is a plain String
-- column whose vocabulary lives in this CHECK.

ALTER TABLE "app"."TrackingSession"
  DROP CONSTRAINT "TrackingSession_endReason_check",
  ADD CONSTRAINT "TrackingSession_endReason_check"
    CHECK ("endReason" IS NULL OR "endReason" IN ('DRIVER', 'SUPERVISOR', 'ASSIGNMENT_COMPLETED', 'ASSIGNMENT_CANCELLED', 'REASSIGNED', 'EXPIRED'));
