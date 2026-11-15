-- Phase 8 hardening — operations register (tasks, incidents, support
-- tickets, notifications): number sequences, vocabulary CHECKs and
-- append-only history protection, in the style of the earlier
-- phases' hardening migrations. Applied after the Prisma-generated
-- Phase 8 migration; the model file cannot express any of this.

-- ---------------------------------------------------------------------------
-- Numbered references (read inside the creating transaction, like
-- order/shipment/return numbers).
-- ---------------------------------------------------------------------------
CREATE SEQUENCE "app"."incident_number_seq" START WITH 1001;
CREATE SEQUENCE "app"."ticket_number_seq" START WITH 1001;

-- ---------------------------------------------------------------------------
-- Task vocabulary (schema doc §10; spec Part 15).
-- ---------------------------------------------------------------------------
ALTER TABLE "app"."Task" ADD CONSTRAINT "Task_priority_chk"
  CHECK ("priority" IN ('LOW', 'NORMAL', 'HIGH', 'URGENT'));
ALTER TABLE "app"."Task" ADD CONSTRAINT "Task_status_chk"
  CHECK ("status" IN ('DRAFT', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS',
    'BLOCKED', 'SUBMITTED', 'UNDER_REVIEW', 'VERIFIED', 'CLOSED',
    'REJECTED', 'CANCELLED'));

-- ---------------------------------------------------------------------------
-- Incident vocabulary (schema doc §10; exception-management.md §1–§3).
-- ---------------------------------------------------------------------------
ALTER TABLE "app"."Incident" ADD CONSTRAINT "Incident_category_chk"
  CHECK ("category" IN ('MISSING_PACKAGE', 'DAMAGED_PACKAGE',
    'WRONG_WAREHOUSE', 'WRONG_PACKAGE_RECEIVED', 'TRANSFER_SHORTAGE',
    'TRANSFER_EXCESS', 'DELIVERY_FAILURE', 'CUSTOMER_REFUSAL',
    'INCORRECT_ADDRESS', 'PICKUP_FAILURE', 'DRIVER_BREAKDOWN',
    'VEHICLE_ACCIDENT', 'THEFT_SUSPICION', 'COD_DISCREPANCY',
    'PAYMENT_DISPUTE', 'DUPLICATE_BOOKING', 'DUPLICATE_SCAN',
    'WEIGHT_DISCREPANCY', 'DELAYED_SHIPMENT', 'CUSTOMER_COMPLAINT',
    'UNAUTHORISED_ACCESS_ATTEMPT', 'HANDOVER_DISCREPANCY'));
ALTER TABLE "app"."Incident" ADD CONSTRAINT "Incident_severity_chk"
  CHECK ("severity" IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'));
ALTER TABLE "app"."Incident" ADD CONSTRAINT "Incident_status_chk"
  CHECK ("status" IN ('REPORTED', 'ACKNOWLEDGED', 'ASSIGNED',
    'INVESTIGATING', 'AWAITING_INFORMATION', 'ESCALATED',
    'RESOLUTION_PROPOSED', 'RESOLUTION_APPROVED', 'RESOLVED', 'CLOSED'));
ALTER TABLE "app"."Incident" ADD CONSTRAINT "Incident_team_chk"
  CHECK ("responsibleTeam" IS NULL OR "responsibleTeam" IN
    ('WAREHOUSE', 'FINANCE', 'SUPPORT', 'OPERATIONS'));
-- A resolved/closed incident always carries its resolution text and
-- stamp; an open one never carries a resolution stamp.
ALTER TABLE "app"."Incident" ADD CONSTRAINT "Incident_resolution_shape_chk"
  CHECK (
    ("status" IN ('RESOLVED', 'CLOSED') AND "resolution" IS NOT NULL AND "resolvedAt" IS NOT NULL)
    OR ("status" NOT IN ('RESOLVED', 'CLOSED') AND "resolvedAt" IS NULL)
  );

-- ---------------------------------------------------------------------------
-- Support ticket vocabulary (spec Part 4.10).
-- ---------------------------------------------------------------------------
ALTER TABLE "app"."SupportTicket" ADD CONSTRAINT "SupportTicket_category_chk"
  CHECK ("category" IN ('NON_RECEIPT', 'DAMAGE', 'PAYMENT_DISPUTE',
    'ADDRESS_CORRECTION', 'REDELIVERY_REQUEST', 'GENERAL'));
ALTER TABLE "app"."SupportTicket" ADD CONSTRAINT "SupportTicket_status_chk"
  CHECK ("status" IN ('OPEN', 'IN_PROGRESS', 'AWAITING_CUSTOMER',
    'ESCALATED', 'RESOLVED', 'CLOSED'));
ALTER TABLE "app"."SupportTicket" ADD CONSTRAINT "SupportTicket_priority_chk"
  CHECK ("priority" IN ('LOW', 'NORMAL', 'HIGH', 'URGENT'));
ALTER TABLE "app"."SupportTicketMessage" ADD CONSTRAINT "SupportTicketMessage_visibility_chk"
  CHECK ("visibility" IN ('PUBLIC', 'INTERNAL'));

-- ---------------------------------------------------------------------------
-- Notification vocabulary (spec Part 17).
-- ---------------------------------------------------------------------------
ALTER TABLE "app"."Notification" ADD CONSTRAINT "Notification_category_chk"
  CHECK ("category" IN ('DELIVERY_OTP', 'DELIVERY_ASSIGNED',
    'OUT_FOR_DELIVERY', 'DELIVERED', 'INCIDENT_CREATED',
    'INCIDENT_ASSIGNED', 'INCIDENT_ESCALATED', 'TASK_ASSIGNED',
    'TICKET_RAISED', 'TICKET_REPLIED', 'TICKET_RESOLVED',
    'SETTLEMENT_PAID', 'RETURN_AUTHORISED', 'COD_DISCREPANCY',
    'GENERAL'));
ALTER TABLE "app"."Notification" ADD CONSTRAINT "Notification_channel_chk"
  CHECK ("channel" IN ('IN_APP', 'TRACKING', 'EMAIL', 'SMS'));
ALTER TABLE "app"."Notification" ADD CONSTRAINT "Notification_delivery_status_chk"
  CHECK ("deliveryStatus" IN ('SENT', 'AVAILABLE',
    'NOT_SENT_NO_PROVIDER', 'FAILED'));
-- A notification is always addressed: to an app user or to a
-- recipient phone identity — never to nobody.
ALTER TABLE "app"."Notification" ADD CONSTRAINT "Notification_addressed_chk"
  CHECK ("userId" IS NOT NULL OR "recipientPhone" IS NOT NULL);
ALTER TABLE "app"."NotificationPreference" ADD CONSTRAINT "NotificationPreference_channel_chk"
  CHECK ("channel" IN ('IN_APP', 'EMAIL', 'SMS'));

-- ---------------------------------------------------------------------------
-- Append-only history protection: the investigation thread, task
-- comments and ticket messages are records of what was said and by
-- whom; they are never rewritten or removed (the existing
-- prevent_history_rewrite function raises on UPDATE and DELETE).
-- ---------------------------------------------------------------------------
CREATE TRIGGER "IncidentNote_append_only"
  BEFORE UPDATE OR DELETE ON "app"."IncidentNote"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_history_rewrite"();
CREATE TRIGGER "TaskComment_append_only"
  BEFORE UPDATE OR DELETE ON "app"."TaskComment"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_history_rewrite"();
CREATE TRIGGER "SupportTicketMessage_append_only"
  BEFORE UPDATE OR DELETE ON "app"."SupportTicketMessage"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_history_rewrite"();

-- Public tracking complaints are raised by phone-verified members
-- of the public who may hold no account: the raiser FK is optional
-- (customerId + contactPhone carry the identity instead).
ALTER TABLE "app"."SupportTicket" ALTER COLUMN "raisedById" DROP NOT NULL;
