-- Phase 2 review P2-5: at most one ACTIVE membership per
-- (user, warehouse, role). The service layer checks before creating,
-- but the check raced under parallel assigns; this partial unique index
-- is the database backstop (a racing insert now fails with P2002, which
-- the service translates to a ConflictError). Prisma cannot express
-- partial indexes in schema.prisma, so this lives in migration SQL
-- only — it is documented on the WarehouseMembership model.
CREATE UNIQUE INDEX "WarehouseMembership_active_user_warehouse_role_key"
  ON "app"."WarehouseMembership" ("userId", "warehouseId", "roleId")
  WHERE "revokedAt" IS NULL;
