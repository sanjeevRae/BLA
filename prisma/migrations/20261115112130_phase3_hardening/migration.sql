-- Phase 3 hardening (docs/database-schema.md §0, §3–§5, §11):
-- status vocabularies as database CHECK constraints, the append-only
-- guard on TrackingEvent (same pattern as AuditLog), subject-shape
-- consistency for tracking events, and the sequences behind the
-- human-facing business numbers (ORD-1001 / SHP-1001, schema doc §0).

-- ---------------------------------------------------------------------
-- Vendors & customers
-- ---------------------------------------------------------------------

ALTER TABLE "app"."Vendor"
  ADD CONSTRAINT "Vendor_verificationStatus_check"
  CHECK ("verificationStatus" IN ('PENDING_VERIFICATION', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED', 'INACTIVE'));

ALTER TABLE "app"."Vendor"
  ADD CONSTRAINT "Vendor_billingPreference_check"
  CHECK ("billingPreference" IN ('PREPAID', 'CREDIT', 'COD_OFFSET'));

ALTER TABLE "app"."VendorUser"
  ADD CONSTRAINT "VendorUser_vendorRole_check"
  CHECK ("vendorRole" IN ('OWNER', 'MANAGER', 'BOOKING_STAFF', 'ACCOUNTS_STAFF'));

ALTER TABLE "app"."VendorAddress"
  ADD CONSTRAINT "VendorAddress_kind_check"
  CHECK ("kind" IN ('PICKUP', 'BILLING', 'OFFICE'));

ALTER TABLE "app"."VendorDocument"
  ADD CONSTRAINT "VendorDocument_documentType_check"
  CHECK ("documentType" IN ('REGISTRATION', 'PAN_VAT', 'TAX_CLEARANCE', 'ID_PROOF', 'OTHER'));

ALTER TABLE "app"."VendorDocument"
  ADD CONSTRAINT "VendorDocument_status_check"
  CHECK ("status" IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED'));

ALTER TABLE "app"."VendorWarehouseAssignment"
  ADD CONSTRAINT "VendorWarehouseAssignment_kind_check"
  CHECK ("kind" IN ('ORIGIN'));

ALTER TABLE "app"."CustomerAddress"
  ADD CONSTRAINT "CustomerAddress_kind_check"
  CHECK ("kind" IN ('PICKUP', 'DELIVERY', 'HOME'));

ALTER TABLE "app"."UserInvitation"
  ADD CONSTRAINT "UserInvitation_vendorRole_check"
  CHECK ("vendorRole" IS NULL OR "vendorRole" IN ('OWNER', 'MANAGER', 'BOOKING_STAFF', 'ACCOUNTS_STAFF'));

-- ---------------------------------------------------------------------
-- Orders, shipments, packages
-- ---------------------------------------------------------------------

ALTER TABLE "app"."Order"
  ADD CONSTRAINT "Order_approvalStatus_check"
  CHECK ("approvalStatus" IN ('PENDING', 'APPROVED', 'REJECTED'));

ALTER TABLE "app"."Order"
  ADD CONSTRAINT "Order_status_check"
  CHECK ("status" IN ('DRAFT', 'SUBMITTED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'));

ALTER TABLE "app"."Order"
  ADD CONSTRAINT "Order_paymentStatus_check"
  CHECK ("paymentStatus" IN ('UNPAID', 'PENDING', 'PARTIAL', 'PAID', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED'));

ALTER TABLE "app"."Order"
  ADD CONSTRAINT "Order_paymentMethod_check"
  CHECK ("paymentMethod" IN ('CASH', 'BANK_TRANSFER', 'MOBILE_WALLET', 'ONLINE_GATEWAY', 'PREPAID_BALANCE', 'CREDIT_ACCOUNT'));

ALTER TABLE "app"."Order"
  ADD CONSTRAINT "Order_pickupMethod_check"
  CHECK ("pickupMethod" IN ('RIDER_PICKUP', 'WAREHOUSE_DROPOFF'));

ALTER TABLE "app"."OrderItem"
  ADD CONSTRAINT "OrderItem_quantity_check" CHECK ("quantity" > 0);

ALTER TABLE "app"."Shipment"
  ADD CONSTRAINT "Shipment_kind_check"
  CHECK ("kind" IN ('FORWARD', 'RETURN', 'EXCHANGE'));

ALTER TABLE "app"."Shipment"
  ADD CONSTRAINT "Shipment_routeKind_check"
  CHECK ("routeKind" IN ('LAST_MILE', 'INTER_WAREHOUSE', 'UNROUTED'));

ALTER TABLE "app"."Shipment"
  ADD CONSTRAINT "Shipment_status_check"
  CHECK ("status" IN ('ACTIVE', 'PARTIALLY_DELIVERED', 'DELIVERED', 'RETURNED', 'CANCELLED'));

ALTER TABLE "app"."Shipment"
  ADD CONSTRAINT "Shipment_amounts_check"
  CHECK ("shippingChargePaisa" >= 0 AND "codAmountPaisa" >= 0);

ALTER TABLE "app"."Package"
  ADD CONSTRAINT "Package_operationalStatus_check"
  CHECK ("operationalStatus" IN (
    'DRAFT', 'BOOKED', 'PICKUP_ASSIGNED', 'PICKUP_IN_PROGRESS', 'PICKED_UP',
    'RECEIVED_AT_ORIGIN', 'INSPECTION_PENDING', 'PROCESSING', 'SORTED',
    'READY_FOR_DISPATCH', 'TRANSFER_ASSIGNED', 'DISPATCHED', 'IN_TRANSIT',
    'ARRIVED_AT_DESTINATION', 'RECEIVING_INSPECTION', 'RECEIVED_AT_DESTINATION',
    'READY_FOR_DELIVERY', 'DELIVERY_ASSIGNED', 'OUT_FOR_DELIVERY',
    'DELIVERY_ATTEMPTED', 'DELIVERED', 'CANCELLED'
  ));

ALTER TABLE "app"."Package"
  ADD CONSTRAINT "Package_condition_check"
  CHECK ("condition" IN ('GOOD', 'DAMAGED', 'SUSPECTED_DAMAGE', 'PACKAGING_COMPROMISED'));

ALTER TABLE "app"."Package"
  ADD CONSTRAINT "Package_paymentStatus_check"
  CHECK ("paymentStatus" IN ('NOT_APPLICABLE', 'PENDING', 'PAID', 'COD_DUE', 'COD_COLLECTED', 'COD_REMITTED', 'COD_SETTLED', 'REFUNDED'));

ALTER TABLE "app"."Package"
  ADD CONSTRAINT "Package_deliveryStatus_check"
  CHECK ("deliveryStatus" IN ('NOT_STARTED', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'ATTEMPTED', 'DELIVERED', 'FAILED', 'REFUSED', 'RETURN_INITIATED', 'RETURNED_TO_WAREHOUSE', 'RETURNED_TO_SENDER'));

ALTER TABLE "app"."Package"
  ADD CONSTRAINT "Package_exceptionStatus_check"
  CHECK ("exceptionStatus" IN ('NONE', 'ON_HOLD', 'ADDRESS_CLARIFICATION_REQUIRED', 'DAMAGED', 'MISSING', 'MISROUTED', 'DELAYED', 'CUSTOMER_UNAVAILABLE', 'RECIPIENT_REFUSED', 'DELIVERY_FAILED', 'PICKUP_FAILED', 'RETURN_REQUESTED', 'RETURN_APPROVED', 'LOST_UNDER_INVESTIGATION', 'RESOLVED'));

ALTER TABLE "app"."Package"
  ADD CONSTRAINT "Package_category_check"
  CHECK ("category" IN ('DOCUMENT', 'PACKAGE', 'FRAGILE', 'PERISHABLE', 'LIQUID', 'OTHER'));

ALTER TABLE "app"."Package"
  ADD CONSTRAINT "Package_cod_check" CHECK ("codAmountPaisa" >= 0);

ALTER TABLE "app"."PackageItem"
  ADD CONSTRAINT "PackageItem_quantity_check" CHECK ("quantity" > 0);

-- ---------------------------------------------------------------------
-- TrackingEvent: shape + append-only
-- ---------------------------------------------------------------------

ALTER TABLE "app"."TrackingEvent"
  ADD CONSTRAINT "TrackingEvent_subjectType_check"
  CHECK ("subjectType" IN ('PACKAGE', 'SHIPMENT', 'ORDER'));

ALTER TABLE "app"."TrackingEvent"
  ADD CONSTRAINT "TrackingEvent_source_check"
  CHECK ("source" IN ('WEB', 'SCANNER', 'MOBILE', 'SYSTEM', 'OFFLINE_SYNC'));

ALTER TABLE "app"."TrackingEvent"
  ADD CONSTRAINT "TrackingEvent_subject_shape_check"
  CHECK (
    ("subjectType" = 'PACKAGE' AND "packageId" IS NOT NULL)
    OR ("subjectType" = 'SHIPMENT' AND "shipmentId" IS NOT NULL)
    OR ("subjectType" = 'ORDER' AND "orderId" IS NOT NULL)
  );

CREATE TRIGGER "TrackingEvent_append_only"
  BEFORE UPDATE OR DELETE ON "app"."TrackingEvent"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_history_rewrite"();

CREATE TRIGGER "TrackingEvent_no_truncate"
  BEFORE TRUNCATE ON "app"."TrackingEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "app"."prevent_history_rewrite"();

-- ---------------------------------------------------------------------
-- Business-number sequences (Order/Shipment numbers, schema doc §0)
-- ---------------------------------------------------------------------

CREATE SEQUENCE "app"."order_number_seq" START WITH 1001;
CREATE SEQUENCE "app"."shipment_number_seq" START WITH 1001;
