-- AuditLog append-only hardening, part 2 (docs/security-architecture.md §8):
-- the row-level trigger from 20261115104303_identity_hardening blocks
-- UPDATE/DELETE, but TRUNCATE never fires row triggers — anyone reaching
-- the database with the app's credentials could wipe the audit trail
-- silently. This statement-level trigger closes that hole, reusing the
-- same guard function so TRUNCATE raises the identical exception
-- ('Table AuditLog is append-only: TRUNCATE is not allowed').

CREATE TRIGGER "AuditLog_no_truncate"
  BEFORE TRUNCATE ON "app"."AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION "app"."prevent_history_rewrite"();
