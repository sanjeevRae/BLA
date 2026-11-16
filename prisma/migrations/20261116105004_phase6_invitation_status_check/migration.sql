-- Phase 6 (V2): extend the UserInvitation status vocabulary for the
-- four-eyes privileged-invitation flow. PENDING_APPROVAL = privileged
-- invitation awaiting a second approver; REJECTED = approver refused
-- it (terminal; the token can never be redeemed). The original
-- constraint came from 20261115104303_identity_hardening.
ALTER TABLE "UserInvitation" DROP CONSTRAINT "UserInvitation_status_check";
ALTER TABLE "UserInvitation"
  ADD CONSTRAINT "UserInvitation_status_check"
  CHECK ("status" IN ('PENDING', 'PENDING_APPROVAL', 'ACCEPTED', 'EXPIRED', 'REVOKED', 'REJECTED'));
