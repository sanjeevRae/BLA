-- Identity hardening (docs/database-schema.md §0, §1):
-- status vocabularies as database CHECK constraints, and the append-only
-- guard on AuditLog (no UPDATE or DELETE, even via direct SQL).

ALTER TABLE "app"."User"
  ADD CONSTRAINT "User_status_check"
  CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'DEACTIVATED'));

ALTER TABLE "app"."UserInvitation"
  ADD CONSTRAINT "UserInvitation_status_check"
  CHECK ("status" IN ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED'));

CREATE OR REPLACE FUNCTION "app"."prevent_history_rewrite"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditLog_append_only"
  BEFORE UPDATE OR DELETE ON "app"."AuditLog"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_history_rewrite"();
