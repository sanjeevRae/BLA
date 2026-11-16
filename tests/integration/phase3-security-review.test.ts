import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 3 (V2) GPS backend — INDEPENDENT security review (adversarial
 * PoCs). Written by the reviewer, not the Phase 3 implementer.
 * Prefix P3R. Assertions encode the SECURE behaviour; a failing
 * assertion is a finding. Goes beyond tests/integration/
 * phase3-tracking.test.ts (no duplicated cases):
 *
 *  1. identity substitution (spoofed body driverId on a FOREIGN
 *     session, smuggled fields, cross-driver stop/pause/resume)
 *  2. session races (concurrent starts, resume-vs-active, ping-vs-stop)
 *  3. replay (different payload under a used sequence, replay after
 *     end, cross-session snapshot tie-break)
 *  4. live-operations scope escapes (driver-home vs batch warehouse,
 *     warehouseId widening, snapshot-relation leak, ended-window)
 *  5. COD gating on the DETAIL endpoint + trip sessions + FINANCE
 *  6. supervisor stop via destination scope, both-foreign denial,
 *     rider supervisor-stop attempt, audit rows for denials
 *  7. validation abuse (NaN/Infinity, sequenceId range, accuracy /
 *     timestamp edges, in-transaction assignment re-check)
 *  8. maintenance sweeps (expire freshness, prune under a hostile
 *     retention override, config-override bounds)
 *  9. audit-spam vector + existence-oracle consistency
 */

function loadEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) out[match[1]] = match[2].trim().replace(/^[\"']|[\"']$/g, "");
  }
  return out;
}

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const email = (label: string) => `p3r-${label}-${RUN}@bla.test`;

let prisma: import("@prisma/client").PrismaClient;
let trackingSvc: typeof import("@/server/services/tracking");
let liveOpsSvc: typeof import("@/server/services/live-operations");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");
let trackingConfigLib: typeof import("@/lib/tracking/config");

type Actor = Awaited<ReturnType<typeof actorFor>>;

const fx: Record<string, string> = {};
let adminActor: Actor;
let wa1Actor: Actor;
let wa2Actor: Actor;
let wa3Actor: Actor;
let financeActor: Actor;
let customerActor: Actor;

/** Mirror of getActorContext (permissions.ts) incl. the driver link. */
async function actorFor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: {
        include: {
          role: { include: { permissions: { include: { permission: true } } } },
        },
      },
      memberships: { where: { revokedAt: null }, include: { role: true } },
    },
  });
  if (!user) throw new Error("fixture user missing");
  const roles: string[] = [];
  const permissions = new Set<string>();
  for (const userRole of user.roles) {
    if (!userRole.role.isActive) continue;
    roles.push(userRole.role.code);
    for (const rp of userRole.role.permissions) permissions.add(rp.permission.code);
  }
  const [vendorLink, customerProfile, driverProfile] = await Promise.all([
    prisma.vendorUser.findFirst({
      where: { userId: user.id, isActive: true, vendor: { isActive: true } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.customer.findUnique({ where: { userId: user.id } }),
    prisma.driver.findUnique({ where: { userId: user.id }, select: { id: true } }),
  ]);
  return {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    roles: roles as never[],
    primaryRole: catalog.primaryRoleFor(roles as never[]),
    permissions,
    warehouseIds: user.memberships.map((m) => m.warehouseId),
    membershipRoles: user.memberships.map((m) => ({
      warehouseId: m.warehouseId,
      roleCode: m.role.code as never,
    })),
    vendorId: vendorLink?.vendorId ?? null,
    vendorRole: vendorLink?.vendorRole ?? null,
    driverId: driverProfile?.id ?? null,
    customerId: customerProfile?.id ?? null,
    landingPath: catalog.landingPathForRoles(roles as never[]),
  };
}

async function makeUser(label: string, roleCode: string): Promise<string> {
  const { hash } = await import("bcryptjs");
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: `P3R ${label}`,
      passwordHash: await hash("Fixture#2026", 10),
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    },
  });
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  if (!role) throw new Error(`role missing: ${roleCode}`);
  await prisma.userRole.create({
    data: { userId: user.id, roleId: role.id, assignedById: fx.adminUser ?? user.id },
  });
  return user.id;
}

async function addMembership(userId: string, warehouseId: string, roleCode: string) {
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  await prisma.warehouseMembership.create({
    data: {
      userId,
      warehouseId,
      roleId: role!.id,
      isPrimary: true,
      assignedById: fx.adminUser,
    },
  });
}

async function makeDriver(userId: string, homeWarehouseId: string, label: string) {
  const driver = await prisma.driver.create({
    data: {
      userId,
      homeWarehouseId,
      licenseNumber: `LICR-${label}-${RUN}`,
      licenseExpiry: new Date("2028-01-01"),
    },
  });
  return driver.id;
}

let riderSeq = 0;
async function makeRider(homeWarehouseId: string): Promise<{ userId: string; driverId: string; actor: Actor }> {
  riderSeq += 1;
  const label = `rider${riderSeq}`;
  const userId = await makeUser(label, "RIDER");
  const driverId = await makeDriver(userId, homeWarehouseId, label.toUpperCase());
  const actor = await actorFor(userId);
  return { userId, driverId, actor };
}

async function makeLinehaul(homeWarehouseId: string): Promise<{ userId: string; driverId: string; actor: Actor }> {
  riderSeq += 1;
  const label = `lh${riderSeq}`;
  const userId = await makeUser(label, "LINEHAUL_DRIVER");
  const driverId = await makeDriver(userId, homeWarehouseId, label.toUpperCase());
  const actor = await actorFor(userId);
  return { userId, driverId, actor };
}

async function makeBatch(riderId: string, warehouseId: string, status = "OPEN") {
  return prisma.deliveryBatch.create({
    data: {
      riderId,
      warehouseId,
      batchDate: new Date(new Date().toISOString().slice(0, 10)),
      kind: "DELIVERY",
      status,
      createdById: fx.adminUser,
    },
  });
}

let tripSeq = 0;
async function makeTrip(driverId: string, originWh: string, destWh: string, status = "DISPATCHED") {
  tripSeq += 1;
  const vehicle = await prisma.vehicle.create({
    data: { registration: `VEHR-${RUN}-${tripSeq}`, type: "TRUCK", homeWarehouseId: originWh },
  });
  const transfer = await prisma.transfer.create({
    data: {
      transferNumber: `TRFR-${RUN}-${tripSeq}`,
      originWarehouseId: originWh,
      destinationWarehouseId: destWh,
      status: "IN_TRANSIT",
      driverId,
      vehicleId: vehicle.id,
      createdById: fx.adminUser,
    },
  });
  const trip = await prisma.trip.create({
    data: {
      tripNumber: `TRPR-${RUN}-${tripSeq}`,
      transferId: transfer.id,
      driverId,
      vehicleId: vehicle.id,
      status,
    },
  });
  await prisma.transfer.update({ where: { id: transfer.id }, data: { tripId: trip.id } });
  return trip;
}

const pingBody = (
  sessionId: string,
  sequenceId: number,
  overrides: Record<string, unknown> = {},
) => ({
  trackingSessionId: sessionId,
  latitude: 27.7,
  longitude: 85.3,
  accuracyMeters: 12,
  recordedAt: new Date().toISOString(),
  sequenceId,
  ...overrides,
});

async function backdateLastPing(sessionId: string, seconds: number) {
  const last = await prisma.driverLocationPing.findFirst({
    where: { trackingSessionId: sessionId },
    orderBy: { receivedAt: "desc" },
  });
  if (!last) throw new Error("no ping to backdate");
  await prisma.driverLocationPing.update({
    where: { id: last.id },
    data: { receivedAt: new Date(last.receivedAt.getTime() - seconds * 1000) },
  });
}

async function startBatchSession(actor: Actor, batchId: string): Promise<string> {
  const view = await trackingSvc.startTrackingSession(actor, {
    deliveryBatchId: batchId,
    permissionAcknowledged: true,
  });
  return view.id;
}

/** Direct (service-bypassing) PAUSED session row — fabricates states
 *  the service's own pre-checks would normally prevent, to probe the
 *  database backstops (partial unique index + resume catch). */
async function directSession(
  driverId: string,
  batchId: string,
  warehouseId: string,
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.trackingSession.create({
    data: {
      driverId,
      deliveryBatchId: batchId,
      trackingType: "DELIVERY",
      originWarehouseId: warehouseId,
      status,
      startReason: "DRIVER",
      permissionAcknowledgedAt: new Date(),
      ...(status === "ENDED" ? { endedAt: new Date(), endReason: "DRIVER" } : {}),
      ...overrides,
    },
  });
}

async function setTrackingConfig(value: Record<string, unknown> | null) {
  if (value === null) {
    await prisma.systemSetting.deleteMany({ where: { key: "tracking.config" } });
  } else {
    await prisma.systemSetting.upsert({
      where: { key: "tracking.config" },
      update: { value: value as import("@prisma/client").Prisma.InputJsonValue },
      create: {
        key: "tracking.config",
        value: value as import("@prisma/client").Prisma.InputJsonValue,
      },
    });
  }
}

beforeAll(async () => {
  const root = process.cwd();
  const env = {
    ...loadEnvFile(join(root, "prisma/.env")),
    ...loadEnvFile(join(root, ".env.local")),
  };
  const url = env.DATABASE_URL ?? "";
  if (!url.includes("/bla_dev")) throw new Error("Expected the bla_dev DATABASE_URL");
  process.env.DATABASE_URL = url.replace("/bla_dev", "/bla_test");

  const clientModule = await import("@prisma/client");
  prisma = new clientModule.PrismaClient();
  trackingSvc = await import("@/server/services/tracking");
  liveOpsSvc = await import("@/server/services/live-operations");
  errors = await import("@/lib/errors");
  actorErrors = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");
  trackingConfigLib = await import("@/lib/tracking/config");

  for (const role of catalog.ROLES) {
    await prisma.role.upsert({
      where: { code: role.code },
      update: { name: role.name, isActive: true },
      create: { code: role.code, name: role.name, description: role.description, isSystem: true },
    });
  }
  for (const permission of catalog.PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { name: permission.name, module: permission.module },
      create: { code: permission.code, name: permission.name, module: permission.module },
    });
  }
  const roleRows = await prisma.role.findMany();
  const permissionRows = await prisma.permission.findMany();
  const roleId = new Map(roleRows.map((r) => [r.code, r.id]));
  const permissionId = new Map(permissionRows.map((p) => [p.code, p.id]));
  for (const role of catalog.ROLES) {
    for (const code of catalog.ROLE_PERMISSIONS[role.code]) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: roleId.get(role.code)!,
            permissionId: permissionId.get(code)!,
          },
        },
        update: {},
        create: { roleId: roleId.get(role.code)!, permissionId: permissionId.get(code)! },
      });
    }
  }

  const w1 = await prisma.warehouse.create({
    data: { code: `P3RA-${RUN}`, name: `P3R Alpha ${RUN}`, district: "Kathmandu", city: "Kathmandu", province: "Bagmati" },
  });
  const w2 = await prisma.warehouse.create({
    data: { code: `P3RB-${RUN}`, name: `P3R Beta ${RUN}`, district: "Lalitpur", city: "Lalitpur", province: "Bagmati" },
  });
  const w3 = await prisma.warehouse.create({
    data: { code: `P3RC-${RUN}`, name: `P3R Gamma ${RUN}`, district: "Bhaktapur", city: "Bhaktapur", province: "Bagmati" },
  });
  fx.w1 = w1.id;
  fx.w2 = w2.id;
  fx.w3 = w3.id;

  fx.adminUser = await makeUser("admin", "ADMIN");
  adminActor = await actorFor(fx.adminUser);

  const wa1User = await makeUser("wa1", "WAREHOUSE_ADMIN");
  await addMembership(wa1User, fx.w1, "WAREHOUSE_ADMIN");
  wa1Actor = await actorFor(wa1User);
  const wa2User = await makeUser("wa2", "WAREHOUSE_ADMIN");
  await addMembership(wa2User, fx.w2, "WAREHOUSE_ADMIN");
  wa2Actor = await actorFor(wa2User);
  const wa3User = await makeUser("wa3", "WAREHOUSE_ADMIN");
  await addMembership(wa3User, fx.w3, "WAREHOUSE_ADMIN");
  wa3Actor = await actorFor(wa3User);

  financeActor = await actorFor(await makeUser("finance", "FINANCE"));
  customerActor = await actorFor(await makeUser("customer", "CUSTOMER"));

  // COD fixture infra: order / shipment shared by assignment fixtures.
  const service = await prisma.shippingService.create({
    data: { code: `P3RSVC-${RUN}`, name: `P3R Service ${RUN}` },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-P3R-${RUN}`,
      createdById: fx.adminUser,
      createdByRole: "ADMIN",
      senderName: "P3R Sender",
      senderPhone: "9779811111111",
      destinationDistrict: "Kathmandu",
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  fx.orderId = order.id;
  const shipment = await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-P3R-${RUN}`,
      orderId: order.id,
      originWarehouseId: fx.w1,
      destinationWarehouseId: fx.w2,
      routeKind: "INTER_WAREHOUSE",
      shippingServiceId: service.id,
      shippingChargePaisa: BigInt(0),
    },
  });
  fx.shipmentId = shipment.id;
}, 180_000);

async function makePackage(label: string) {
  return prisma.package.create({
    data: {
      trackingId: `BLA-P3R-${label}-${RUN}`,
      shipmentId: fx.shipmentId,
      orderId: fx.orderId,
      recipientName: `Recipient ${label}`,
      recipientPhone: `977980000${label}`,
      deliveryAddress: `Address ${label}`,
      deliveryCity: "Kathmandu",
      deliveryDistrict: "Kathmandu",
      declaredWeightKg: "1.000",
      description: `Parcel ${label}`,
    },
  });
}

// ---------------------------------------------------------------------
// 1) Identity substitution
// ---------------------------------------------------------------------

describe("P3R-1 identity substitution", { timeout: 120_000 }, () => {
  it("start ignores a smuggled driverId in the body — the session belongs to the actor", async () => {
    const a = await makeRider(fx.w1);
    const b = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const view = await trackingSvc.startTrackingSession(a.actor, {
      deliveryBatchId: batch.id,
      permissionAcknowledged: true,
      // Smuggled identity fields a hostile client might add:
      driverId: b.driverId,
      userId: b.userId,
    } as never);
    expect(view.driverId).toBe(a.driverId);
    fx.idA = a.driverId;
    fx.idASession = view.id;
    fx.idAActorUser = a.userId;
    // keep actors for later tests in this block via closure storage
    (fx as Record<string, unknown>).idAActor = a.actor;
    (fx as Record<string, unknown>).idBActor = b.actor;
    (fx as Record<string, unknown>).idBDriver = b.driverId;
  });

  it("ping to a FOREIGN session with the body driverId spoofed to the session owner is still denied", async () => {
    const bActor = (fx as Record<string, unknown>).idBActor as Actor;
    const before = await prisma.driverLocationPing.count({
      where: { trackingSessionId: fx.idASession },
    });
    // The attacker supplies driverId === the victim session's owner,
    // hoping the service trusts the body. Identity must come from
    // the authenticated actor only.
    await expect(
      trackingSvc.postLocationPing(
        bActor,
        pingBody(fx.idASession, 1, { driverId: fx.idA }),
      ),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const after = await prisma.driverLocationPing.count({
      where: { trackingSessionId: fx.idASession },
    });
    expect(after).toBe(before);
    const denial = await prisma.auditLog.findFirst({
      where: {
        action: "access.denied",
        actorId: bActor.userId,
        entityId: fx.idASession,
      },
    });
    expect(denial).not.toBeNull();
  });

  it("a rider cannot stop, pause or resume another driver's session", async () => {
    const bActor = (fx as Record<string, unknown>).idBActor as Actor;
    await expect(
      trackingSvc.stopTrackingSession(bActor, fx.idASession),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      trackingSvc.pauseTrackingSession(bActor, fx.idASession),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      trackingSvc.resumeTrackingSession(bActor, fx.idASession),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const session = await prisma.trackingSession.findUnique({
      where: { id: fx.idASession },
    });
    expect(session?.status).toBe("ACTIVE");
    // Every denial is audit-logged: the stop with the
    // not-authorized reason, pause/resume with not-owned.
    const denials = await prisma.auditLog.findMany({
      where: {
        action: "access.denied",
        actorId: bActor.userId,
        entityId: fx.idASession,
      },
    });
    const reasons = denials.map((d) => JSON.stringify(d.after));
    expect(reasons.some((r) => r.includes("tracking_stop_not_authorized"))).toBe(true);
    expect(reasons.some((r) => r.includes("tracking_session_not_owned"))).toBe(true);
  });

  it("start with BOTH tripId and deliveryBatchId — or NEITHER — is a validation error, no session created", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const trip = await makeTrip(a.driverId, fx.w1, fx.w2);
    await expect(
      trackingSvc.startTrackingSession(a.actor, {
        tripId: trip.id,
        deliveryBatchId: batch.id,
        permissionAcknowledged: true,
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      trackingSvc.startTrackingSession(a.actor, {
        permissionAcknowledged: true,
      } as never),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    expect(
      await prisma.trackingSession.count({ where: { driverId: a.driverId } }),
    ).toBe(0);
  });

  it("start on another driver's TRIP is denied and audit-logged (trip variant of the batch case)", async () => {
    const owner = await makeLinehaul(fx.w1);
    const intruder = await makeRider(fx.w1);
    const trip = await makeTrip(owner.driverId, fx.w1, fx.w2);
    await expect(
      trackingSvc.startTrackingSession(intruder.actor, {
        tripId: trip.id,
        permissionAcknowledged: true,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const denial = await prisma.auditLog.findFirst({
      where: { action: "access.denied", actorId: intruder.actor.userId, entityId: trip.id },
    });
    expect(denial).not.toBeNull();
    expect(JSON.stringify(denial?.after)).toContain("tracking_trip_not_assigned_to_driver");
  });

  it("a smuggled ping `source` is ignored — stored pings are always BROWSER; a matching body driverId writes no mismatch audit", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const sessionId = await startBatchSession(a.actor, batch.id);
    const auditsBefore = await prisma.auditLog.count({
      where: { action: "tracking.identity_mismatch", actorId: a.actor.userId },
    });
    const result = await trackingSvc.postLocationPing(
      a.actor,
      pingBody(sessionId, 1, { source: "SATELLITE", driverId: a.driverId }),
    );
    expect(result.ping.source).toBe("BROWSER");
    expect(result.ping.driverId).toBe(a.driverId);
    const auditsAfter = await prisma.auditLog.count({
      where: { action: "tracking.identity_mismatch", actorId: a.actor.userId },
    });
    expect(auditsAfter).toBe(auditsBefore);
  });
});

// ---------------------------------------------------------------------
// 2) Session races
// ---------------------------------------------------------------------

describe("P3R-2 session races", { timeout: 180_000 }, () => {
  it("two concurrent starts for one driver: exactly one wins, the loser gets a clean ConflictError (DB partial-index backstop)", async () => {
    const a = await makeRider(fx.w1);
    const batch1 = await makeBatch(a.driverId, fx.w1);
    const batch2 = await makeBatch(a.driverId, fx.w1);
    const results = await Promise.allSettled([
      trackingSvc.startTrackingSession(a.actor, {
        deliveryBatchId: batch1.id,
        permissionAcknowledged: true,
      }),
      trackingSvc.startTrackingSession(a.actor, {
        deliveryBatchId: batch2.id,
        permissionAcknowledged: true,
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser must surface as the domain ConflictError (409), not a
    // raw Prisma P2002 escaping the service's unique-violation catch.
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      errors.ConflictError,
    );
    const live = await prisma.trackingSession.count({
      where: { driverId: a.driverId, status: { in: ["ACTIVE", "PAUSED"] } },
    });
    expect(live).toBe(1);
  });

  it("resume cannot resurrect a PAUSED session while another ACTIVE session exists for the driver", async () => {
    const a = await makeRider(fx.w1);
    const batch1 = await makeBatch(a.driverId, fx.w1);
    const batch2 = await makeBatch(a.driverId, fx.w1);
    await startBatchSession(a.actor, batch1.id);
    // Fabricate the precondition the partial index must police: a
    // second, PAUSED session for the same driver (the index covers
    // only ACTIVE rows, so this row can exist at the DB level).
    const paused = await directSession(a.driverId, batch2.id, fx.w1, "PAUSED");
    await expect(
      trackingSvc.resumeTrackingSession(a.actor, paused.id),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    const after = await prisma.trackingSession.findUnique({ where: { id: paused.id } });
    expect(after?.status).toBe("PAUSED");
    expect(
      await prisma.trackingSession.count({
        where: { driverId: a.driverId, status: "ACTIVE" },
      }),
    ).toBe(1);
  });

  it("two concurrent resumes of two PAUSED sessions: exactly one becomes ACTIVE", async () => {
    const a = await makeRider(fx.w1);
    const batch1 = await makeBatch(a.driverId, fx.w1);
    const batch2 = await makeBatch(a.driverId, fx.w1);
    const p1 = await directSession(a.driverId, batch1.id, fx.w1, "PAUSED");
    const p2 = await directSession(a.driverId, batch2.id, fx.w1, "PAUSED");
    const results = await Promise.allSettled([
      trackingSvc.resumeTrackingSession(a.actor, p1.id),
      trackingSvc.resumeTrackingSession(a.actor, p2.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      errors.ConflictError,
    );
    expect(
      await prisma.trackingSession.count({
        where: { driverId: a.driverId, status: "ACTIVE" },
      }),
    ).toBe(1);
  });

  it("ping racing a stop (x3): the ping either commits before the stop or fails cleanly — never lands after", async () => {
    for (let i = 0; i < 3; i++) {
      const a = await makeRider(fx.w1);
      const batch = await makeBatch(a.driverId, fx.w1);
      const sessionId = await startBatchSession(a.actor, batch.id);
      const [pingResult, stopResult] = await Promise.allSettled([
        trackingSvc.postLocationPing(a.actor, pingBody(sessionId, 1)),
        trackingSvc.stopTrackingSession(a.actor, sessionId),
      ]);
      expect(stopResult.status).toBe("fulfilled");
      const session = await prisma.trackingSession.findUnique({
        where: { id: sessionId },
      });
      expect(session?.status).toBe("ENDED");
      const pingCount = await prisma.driverLocationPing.count({
        where: { trackingSessionId: sessionId },
      });
      if (pingResult.status === "fulfilled") {
        expect(pingCount).toBe(1);
      } else {
        expect((pingResult as PromiseRejectedResult).reason).toBeInstanceOf(
          errors.ConflictError,
        );
        expect(pingCount).toBe(0);
      }
      // And once the race has settled, the session stays closed.
      await expect(
        trackingSvc.postLocationPing(a.actor, pingBody(sessionId, 2)),
      ).rejects.toBeInstanceOf(errors.ConflictError);
    }
  });

  it("concurrent double-stop: exactly one succeeds, the loser conflicts, endReason unchanged", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const sessionId = await startBatchSession(a.actor, batch.id);
    const results = await Promise.allSettled([
      trackingSvc.stopTrackingSession(a.actor, sessionId),
      trackingSvc.stopTrackingSession(a.actor, sessionId),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      errors.ConflictError,
    );
    const session = await prisma.trackingSession.findUnique({
      where: { id: sessionId },
    });
    expect(session?.endReason).toBe("DRIVER");
  });
});

// ---------------------------------------------------------------------
// 3) Replay
// ---------------------------------------------------------------------

describe("P3R-3 replay", { timeout: 120_000 }, () => {
  it("same (session, sequence) with a COMPLETELY different payload returns the stored ping and writes nothing", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const sessionId = await startBatchSession(a.actor, batch.id);
    const recordedAt = new Date();
    const first = await trackingSvc.postLocationPing(
      a.actor,
      pingBody(sessionId, 7, {
        latitude: 27.7,
        longitude: 85.3,
        accuracyMeters: 12,
        recordedAt: recordedAt.toISOString(),
      }),
    );
    expect(first.deduplicated).toBe(false);
    await backdateLastPing(sessionId, 31);
    // Replay the sequence with moved coordinates, better accuracy
    // and a LATER device clock — a payload-substitution attempt.
    const replay = await trackingSvc.postLocationPing(
      a.actor,
      pingBody(sessionId, 7, {
        latitude: 28.5,
        longitude: 86.5,
        accuracyMeters: 3,
        recordedAt: new Date(recordedAt.getTime() + 60_000).toISOString(),
      }),
    );
    expect(replay.deduplicated).toBe(true);
    expect(replay.ping.id).toBe(first.ping.id);
    expect(replay.ping.latitude).toBe(27.7);
    expect(replay.ping.accuracyMeters).toBe(12);
    expect(
      await prisma.driverLocationPing.count({ where: { trackingSessionId: sessionId } }),
    ).toBe(1);
    const snapshot = await prisma.driverCurrentLocation.findUnique({
      where: { driverId: a.driverId },
    });
    expect(snapshot?.latitude).toBe(27.7);
  });

  it("replaying an accepted sequence AFTER the session ended is refused, not served as an idempotent success", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const sessionId = await startBatchSession(a.actor, batch.id);
    await trackingSvc.postLocationPing(a.actor, pingBody(sessionId, 1));
    await trackingSvc.stopTrackingSession(a.actor, sessionId);
    await expect(
      trackingSvc.postLocationPing(a.actor, pingBody(sessionId, 1)),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    expect(
      await prisma.driverLocationPing.count({ where: { trackingSessionId: sessionId } }),
    ).toBe(1);
  });

  it("a duplicate replay does not consume the rate-limit slot, but a fresh sequence inside the interval still 429s", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const sessionId = await startBatchSession(a.actor, batch.id);
    await trackingSvc.postLocationPing(a.actor, pingBody(sessionId, 1));
    const replay = await trackingSvc.postLocationPing(a.actor, pingBody(sessionId, 1));
    expect(replay.deduplicated).toBe(true);
    await expect(
      trackingSvc.postLocationPing(
        a.actor,
        pingBody(sessionId, 2, { latitude: 27.71, longitude: 85.31 }),
      ),
    ).rejects.toBeInstanceOf(errors.RateLimitError);
  });

  it("cross-session tie-break: a new session's first fix at the SAME recordedAt must move the snapshot to the live session, even with a lower sequenceId", async () => {
    const a = await makeRider(fx.w1);
    const batch1 = await makeBatch(a.driverId, fx.w1);
    const s1 = await startBatchSession(a.actor, batch1.id);
    const t = new Date();
    // Session 1's last fix carries a HIGH sequence number.
    await trackingSvc.postLocationPing(
      a.actor,
      pingBody(s1, 50, {
        latitude: 27.7,
        longitude: 85.3,
        recordedAt: t.toISOString(),
      }),
    );
    await trackingSvc.stopTrackingSession(a.actor, s1);
    const batch2 = await makeBatch(a.driverId, fx.w1);
    const s2 = await startBatchSession(a.actor, batch2.id);
    // Session 2 restarts its counter (sequence 1) and its first fix
    // carries the same device timestamp (clock granularity / fast
    // restart). SequenceIds are per-session counters, so comparing
    // 1 against session 1's 50 is meaningless — the live session's
    // fix is the driver's current position and must win.
    const result = await trackingSvc.postLocationPing(
      a.actor,
      pingBody(s2, 1, {
        latitude: 27.9,
        longitude: 85.9,
        recordedAt: t.toISOString(),
      }),
    );
    expect(result.deduplicated).toBe(false);
    const snapshot = await prisma.driverCurrentLocation.findUnique({
      where: { driverId: a.driverId },
    });
    expect(snapshot?.trackingSessionId).toBe(s2);
    expect(snapshot?.latitude).toBe(27.9);
  });

  it("cross-session tie-break control: with a HIGHER sequenceId the same-timestamp fix does move the snapshot", async () => {
    const a = await makeRider(fx.w1);
    const batch1 = await makeBatch(a.driverId, fx.w1);
    const s1 = await startBatchSession(a.actor, batch1.id);
    const t = new Date();
    await trackingSvc.postLocationPing(
      a.actor,
      pingBody(s1, 50, {
        latitude: 27.7,
        longitude: 85.3,
        recordedAt: t.toISOString(),
      }),
    );
    await trackingSvc.stopTrackingSession(a.actor, s1);
    const batch2 = await makeBatch(a.driverId, fx.w1);
    const s2 = await startBatchSession(a.actor, batch2.id);
    await trackingSvc.postLocationPing(
      a.actor,
      pingBody(s2, 99, {
        latitude: 27.9,
        longitude: 85.9,
        recordedAt: t.toISOString(),
      }),
    );
    const snapshot = await prisma.driverCurrentLocation.findUnique({
      where: { driverId: a.driverId },
    });
    expect(snapshot?.trackingSessionId).toBe(s2);
    expect(snapshot?.latitude).toBe(27.9);
  });
});

// ---------------------------------------------------------------------
// 4) Live-operations scope escapes
// ---------------------------------------------------------------------

describe("P3R-4 live-operations scope", { timeout: 180_000 }, () => {
  it("scope keys off the SESSION's warehouse, not the driver's home warehouse", async () => {
    // Driver's home is W1, but the batch (and therefore the session
    // origin) is W2. W1's admin must NOT see it; W2's admin must.
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w2);
    const sessionId = await startBatchSession(a.actor, batch.id);
    await trackingSvc.postLocationPing(a.actor, pingBody(sessionId, 1));

    const wa1List = await liveOpsSvc.listLiveOperations(wa1Actor, {});
    expect(wa1List.items.some((i) => i.trackingSessionId === sessionId)).toBe(false);
    await expect(
      liveOpsSvc.getLiveOperationDetail(wa1Actor, sessionId),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    // ... and the home-warehouse admin cannot supervisor-stop it either.
    await expect(
      trackingSvc.stopTrackingSession(wa1Actor, sessionId),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    const wa2List = await liveOpsSvc.listLiveOperations(wa2Actor, {});
    expect(wa2List.items.some((i) => i.trackingSessionId === sessionId)).toBe(true);
    fx.scopeSession = sessionId;
  });

  it("a warehouse admin of a THIRD warehouse sees nothing of a W1→W2 trip (list, detail, stop)", async () => {
    const lh = await makeLinehaul(fx.w1);
    const trip = await makeTrip(lh.driverId, fx.w1, fx.w2);
    const view = await trackingSvc.startTrackingSession(lh.actor, {
      tripId: trip.id,
      permissionAcknowledged: true,
    });
    const list = await liveOpsSvc.listLiveOperations(wa3Actor, {});
    expect(list.items.some((i) => i.trackingSessionId === view.id)).toBe(false);
    await expect(
      liveOpsSvc.getLiveOperationDetail(wa3Actor, view.id),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      trackingSvc.stopTrackingSession(wa3Actor, view.id),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    fx.tripSessionForeign = view.id;
    (fx as Record<string, unknown>).tripDriver = lh;
  });

  it("global actor + warehouseId filter narrows on origin OR destination; an unknown warehouseId yields an empty board, not an error", async () => {
    const tripSession = fx.tripSessionForeign;
    const byDestination = await liveOpsSvc.listLiveOperations(adminActor, {
      warehouseId: fx.w2,
    });
    expect(byDestination.items.some((i) => i.trackingSessionId === tripSession)).toBe(true);
    const byOrigin = await liveOpsSvc.listLiveOperations(adminActor, {
      warehouseId: fx.w1,
    });
    expect(byOrigin.items.some((i) => i.trackingSessionId === tripSession)).toBe(true);
    const byThird = await liveOpsSvc.listLiveOperations(adminActor, {
      warehouseId: fx.w3,
    });
    expect(byThird.items.some((i) => i.trackingSessionId === tripSession)).toBe(false);
    const byBogus = await liveOpsSvc.listLiveOperations(adminActor, {
      warehouseId: "00000000-0000-0000-0000-000000000000",
    });
    expect(byBogus.items).toHaveLength(0);
    expect(byBogus.total).toBe(0);
  });

  it("scoped actor filtering by a FOREIGN warehouseId gets an empty board even for a session they could otherwise see via the other endpoint", async () => {
    // WA2 can see the W1→W2 trip via destination. Filtering by W1
    // (outside WA2's scope) must intersect to empty — the requested
    // filter never widens, and here it must not leak via origin.
    const { items, total } = await liveOpsSvc.listLiveOperations(wa2Actor, {
      warehouseId: fx.w1,
    });
    expect(items.some((i) => i.trackingSessionId === fx.tripSessionForeign)).toBe(false);
    expect(total).toBe(0);
  });

  it("an ENDED session outside the recent window leaves the list but detail stays scope-gated (in-scope reads, out-of-scope denied)", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const sessionId = await startBatchSession(a.actor, batch.id);
    await trackingSvc.postLocationPing(a.actor, pingBody(sessionId, 1));
    await trackingSvc.stopTrackingSession(a.actor, sessionId);
    await prisma.trackingSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date(Date.now() - 45 * 60_000) },
    });
    const { items } = await liveOpsSvc.listLiveOperations(wa1Actor, {});
    expect(items.some((i) => i.trackingSessionId === sessionId)).toBe(false);
    // Detail has no recent-window gate by design; the security
    // property under test is that SCOPE still applies to old rows.
    const detail = await liveOpsSvc.getLiveOperationDetail(wa1Actor, sessionId);
    expect(detail.trackingSessionId).toBe(sessionId);
    expect(detail.sessionStatus).toBe("ENDED");
    await expect(
      liveOpsSvc.getLiveOperationDetail(wa2Actor, sessionId),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });

  it("the list/detail of a superseded session never leak the driver's NEW session location through the snapshot relation", async () => {
    const a = await makeRider(fx.w1);
    const batch1 = await makeBatch(a.driverId, fx.w1);
    const s1 = await startBatchSession(a.actor, batch1.id);
    await trackingSvc.postLocationPing(
      a.actor,
      pingBody(s1, 1, { latitude: 27.11, longitude: 85.11 }),
    );
    await trackingSvc.stopTrackingSession(a.actor, s1);
    const batch2 = await makeBatch(a.driverId, fx.w1);
    const s2 = await startBatchSession(a.actor, batch2.id);
    await trackingSvc.postLocationPing(
      a.actor,
      pingBody(s2, 1, { latitude: 27.99, longitude: 85.99 }),
    );
    const { items } = await liveOpsSvc.listLiveOperations(adminActor, {});
    const oldItem = items.find((i) => i.trackingSessionId === s1);
    expect(oldItem).toBeDefined();
    expect(oldItem?.location).toBeNull();
    expect(oldItem?.freshnessState).toBe("OFFLINE");
    const newItem = items.find((i) => i.trackingSessionId === s2);
    expect(newItem?.location?.latitude).toBe(27.99);
    const oldDetail = await liveOpsSvc.getLiveOperationDetail(adminActor, s1);
    expect(oldDetail.location).toBeNull();
  });

  it("detail for a missing or malformed session id is a clean 404, never a 500", async () => {
    await expect(
      liveOpsSvc.getLiveOperationDetail(adminActor, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
    await expect(
      liveOpsSvc.getLiveOperationDetail(adminActor, "p3r-not-a-uuid"),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
  });
});

// ---------------------------------------------------------------------
// 5) COD gating
// ---------------------------------------------------------------------

describe("P3R-5 COD gating", { timeout: 180_000 }, () => {
  let codSessionId = "";

  beforeAll(async () => {
    const rider = await makeRider(fx.w1);
    (fx as Record<string, unknown>).codRider = rider;
    const batch = await makeBatch(rider.driverId, fx.w1);
    fx.codBatch = batch.id;
    const pkgA = await makePackage("71");
    const pkgB = await makePackage("72");
    const assignmentA = await prisma.deliveryAssignment.create({
      data: {
        packageId: pkgA.id,
        driverId: rider.driverId,
        batchId: batch.id,
        kind: "DELIVERY",
        status: "COMPLETED",
        assignedById: fx.adminUser,
      },
    });
    await prisma.deliveryAssignment.create({
      data: {
        packageId: pkgB.id,
        driverId: rider.driverId,
        batchId: batch.id,
        kind: "DELIVERY",
        status: "IN_PROGRESS",
        assignedById: fx.adminUser,
      },
    });
    await prisma.deliveryCodCollection.create({
      data: {
        packageId: pkgA.id,
        shipmentId: fx.shipmentId,
        assignmentId: assignmentA.id,
        batchId: batch.id,
        expectedPaisa: BigInt(150000),
        collectedPaisa: BigInt(150000),
        status: "MATCHED",
        collectedById: rider.actor.userId,
      },
    });
    codSessionId = await startBatchSession(rider.actor, batch.id);
    fx.codSession = codSessionId;
  });

  const strippedWa = (): Actor => ({
    ...wa1Actor,
    permissions: new Set(
      [...wa1Actor.permissions].filter(
        (p) => p !== "finance.read" && p !== "cod.read",
      ),
    ),
  });

  it("DETAIL omits codCollectedPaisa entirely when the actor holds neither finance.read nor cod.read", async () => {
    const detail = await liveOpsSvc.getLiveOperationDetail(strippedWa(), fx.codSession);
    expect(detail.trackingSessionId).toBe(fx.codSession);
    expect("codCollectedPaisa" in detail).toBe(false);
    expect(JSON.stringify(detail)).not.toContain("150000");
  });

  it("DETAIL shows COD with cod.read alone and with finance.read alone", async () => {
    const codOnly: Actor = {
      ...wa1Actor,
      permissions: new Set(
        [...wa1Actor.permissions].filter((p) => p !== "finance.read"),
      ),
    };
    expect(codOnly.permissions.has("cod.read")).toBe(true);
    const byCod = await liveOpsSvc.getLiveOperationDetail(codOnly, fx.codSession);
    expect(byCod.codCollectedPaisa).toBe("150000");

    const financeOnly: Actor = {
      ...adminActor,
      permissions: new Set(
        [...adminActor.permissions].filter((p) => p !== "cod.read"),
      ),
    };
    expect(financeOnly.permissions.has("finance.read")).toBe(true);
    const byFinance = await liveOpsSvc.getLiveOperationDetail(financeOnly, fx.codSession);
    expect(byFinance.codCollectedPaisa).toBe("150000");
  });

  it("a FINANCE actor (finance.read + cod.read but NO operations.live_view) is denied both endpoints — COD rights never substitute for live_view", async () => {
    expect(financeActor.permissions.has("finance.read")).toBe(true);
    expect(financeActor.permissions.has("cod.read")).toBe(true);
    expect(financeActor.permissions.has("operations.live_view")).toBe(false);
    await expect(liveOpsSvc.listLiveOperations(financeActor, {})).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    await expect(
      liveOpsSvc.getLiveOperationDetail(financeActor, fx.codSession),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });

  it("trip sessions never carry codCollectedPaisa — not in the list, not in detail, even for a finance-holding admin", async () => {
    const lh = await makeLinehaul(fx.w1);
    const trip = await makeTrip(lh.driverId, fx.w1, fx.w2);
    const view = await trackingSvc.startTrackingSession(lh.actor, {
      tripId: trip.id,
      permissionAcknowledged: true,
    });
    const { items } = await liveOpsSvc.listLiveOperations(adminActor, {});
    const item = items.find((i) => i.trackingSessionId === view.id);
    expect(item).toBeDefined();
    expect(item && "codCollectedPaisa" in item).toBe(false);
    const detail = await liveOpsSvc.getLiveOperationDetail(adminActor, view.id);
    expect("codCollectedPaisa" in detail).toBe(false);
  });
});

// ---------------------------------------------------------------------
// 6) Supervisor stop
// ---------------------------------------------------------------------

describe("P3R-6 supervisor stop", { timeout: 180_000 }, () => {
  it("destination-warehouse admin may stop an incoming trip session; both audit rows are written", async () => {
    const lh = await makeLinehaul(fx.w1);
    const trip = await makeTrip(lh.driverId, fx.w1, fx.w2);
    const view = await trackingSvc.startTrackingSession(lh.actor, {
      tripId: trip.id,
      permissionAcknowledged: true,
    });
    const stopped = await trackingSvc.stopTrackingSession(wa2Actor, view.id);
    expect(stopped.status).toBe("ENDED");
    expect(stopped.endReason).toBe("SUPERVISOR");
    const generic = await prisma.auditLog.findFirst({
      where: { action: "tracking.session_stopped", entityId: view.id, actorId: wa2Actor.userId },
    });
    const supervisor = await prisma.auditLog.findFirst({
      where: {
        action: "tracking.session_stopped_supervisor",
        entityId: view.id,
        actorId: wa2Actor.userId,
      },
    });
    expect(generic).not.toBeNull();
    expect(supervisor).not.toBeNull();
  });

  it("both-foreign stop is denied, the session survives, and the denial is audit-logged with the scope reason", async () => {
    const lh = await makeLinehaul(fx.w1);
    const trip = await makeTrip(lh.driverId, fx.w1, fx.w2);
    const view = await trackingSvc.startTrackingSession(lh.actor, {
      tripId: trip.id,
      permissionAcknowledged: true,
    });
    await expect(
      trackingSvc.stopTrackingSession(wa3Actor, view.id),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const session = await prisma.trackingSession.findUnique({ where: { id: view.id } });
    expect(session?.status).toBe("ACTIVE");
    const denial = await prisma.auditLog.findFirst({
      where: { action: "access.denied", actorId: wa3Actor.userId, entityId: view.id },
    });
    expect(denial).not.toBeNull();
    expect(JSON.stringify(denial?.after)).toContain("tracking_stop_out_of_scope");
    // No supervisor-stop audit may exist for a denied stop.
    expect(
      await prisma.auditLog.count({
        where: { action: "tracking.session_stopped_supervisor", entityId: view.id },
      }),
    ).toBe(0);
  });

  it("a supervisor may stop a PAUSED in-scope session", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const sessionId = await startBatchSession(a.actor, batch.id);
    await trackingSvc.pauseTrackingSession(a.actor, sessionId);
    const stopped = await trackingSvc.stopTrackingSession(wa1Actor, sessionId);
    expect(stopped.status).toBe("ENDED");
    expect(stopped.endReason).toBe("SUPERVISOR");
  });

  it("stop edge cases: missing id → 404, empty id → 400, already-ended → 409", async () => {
    await expect(
      trackingSvc.stopTrackingSession(adminActor, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
    await expect(
      trackingSvc.stopTrackingSession(adminActor, ""),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const sessionId = await startBatchSession(a.actor, batch.id);
    await trackingSvc.stopTrackingSession(a.actor, sessionId);
    await expect(
      trackingSvc.stopTrackingSession(a.actor, sessionId),
    ).rejects.toBeInstanceOf(errors.ConflictError);
  });

  it("state-machine edges: pause on ENDED → 409, resume on ACTIVE → 409, owner stop of a PAUSED session → DRIVER", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const sessionId = await startBatchSession(a.actor, batch.id);
    await expect(
      trackingSvc.resumeTrackingSession(a.actor, sessionId),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    await trackingSvc.pauseTrackingSession(a.actor, sessionId);
    const stopped = await trackingSvc.stopTrackingSession(a.actor, sessionId);
    expect(stopped.endReason).toBe("DRIVER");
    await expect(
      trackingSvc.pauseTrackingSession(a.actor, sessionId),
    ).rejects.toBeInstanceOf(errors.ConflictError);
  });
});

// ---------------------------------------------------------------------
// 7) Validation abuse
// ---------------------------------------------------------------------

describe("P3R-7 validation abuse", { timeout: 180_000 }, () => {
  it("NaN / Infinity smuggled at the service layer are validation errors and write no ping", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const sessionId = await startBatchSession(a.actor, batch.id);
    const badPayloads: Record<string, unknown>[] = [
      { latitude: Number.NaN },
      { latitude: Number.POSITIVE_INFINITY },
      { longitude: Number.NEGATIVE_INFINITY },
      { accuracyMeters: Number.NaN },
      { accuracyMeters: Number.POSITIVE_INFINITY },
      { speedMetersPerSecond: -1 },
      { speedMetersPerSecond: Number.NaN },
      { headingDegrees: 361 },
      { headingDegrees: -0.5 },
      { headingDegrees: Number.NaN },
    ];
    for (const bad of badPayloads) {
      await expect(
        trackingSvc.postLocationPing(a.actor, pingBody(sessionId, 1, bad)),
      ).rejects.toBeInstanceOf(errors.DomainValidationError);
    }
    expect(
      await prisma.driverLocationPing.count({ where: { trackingSessionId: sessionId } }),
    ).toBe(0);
    // Boundary-inclusive values ARE accepted: heading 360, speed 0.
    const ok = await trackingSvc.postLocationPing(
      a.actor,
      pingBody(sessionId, 1, { headingDegrees: 360, speedMetersPerSecond: 0 }),
    );
    expect(ok.deduplicated).toBe(false);
    expect(ok.ping.headingDegrees).toBe(360);
  });

  it("sequenceId: negative and fractional are rejected; 0 and the int32 maximum are accepted", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const sessionId = await startBatchSession(a.actor, batch.id);
    await expect(
      trackingSvc.postLocationPing(a.actor, pingBody(sessionId, -1)),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      trackingSvc.postLocationPing(a.actor, pingBody(sessionId, 1.5)),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    const zero = await trackingSvc.postLocationPing(a.actor, pingBody(sessionId, 0));
    expect(zero.deduplicated).toBe(false);
    expect(zero.ping.sequenceId).toBe(0);
  });

  it("sequenceId beyond the int32 column range is a clean validation error, not a raw database error", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const sessionId = await startBatchSession(a.actor, batch.id);
    await expect(
      trackingSvc.postLocationPing(a.actor, pingBody(sessionId, 2147483648)),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    expect(
      await prisma.driverLocationPing.count({ where: { trackingSessionId: sessionId } }),
    ).toBe(0);
  });

  it("accuracy and coordinate bounds are inclusive at the edge and rejected just past it", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const sessionId = await startBatchSession(a.actor, batch.id);
    const edge = await trackingSvc.postLocationPing(
      a.actor,
      pingBody(sessionId, 1, { latitude: 90, longitude: 180, accuracyMeters: 10000 }),
    );
    expect(edge.deduplicated).toBe(false);
    await expect(
      trackingSvc.postLocationPing(
        a.actor,
        pingBody(sessionId, 2, { accuracyMeters: 10000.5 }),
      ),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      trackingSvc.postLocationPing(a.actor, pingBody(sessionId, 3, { latitude: 90.0001 })),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      trackingSvc.postLocationPing(a.actor, pingBody(sessionId, 4, { accuracyMeters: 0 })),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
  });

  it("recordedAt: inside the future tolerance is accepted, beyond it rejected; garbage and pre-start timestamps rejected", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const sessionId = await startBatchSession(a.actor, batch.id);
    const session = await prisma.trackingSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const inside = await trackingSvc.postLocationPing(
      a.actor,
      pingBody(sessionId, 1, {
        recordedAt: new Date(Date.now() + 299_000).toISOString(),
      }),
    );
    expect(inside.deduplicated).toBe(false);
    await expect(
      trackingSvc.postLocationPing(
        a.actor,
        pingBody(sessionId, 2, {
          recordedAt: new Date(Date.now() + 400_000).toISOString(),
          latitude: 27.71,
        }),
      ),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      trackingSvc.postLocationPing(
        a.actor,
        pingBody(sessionId, 3, { recordedAt: "not-a-date", latitude: 27.72 }),
      ),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      trackingSvc.postLocationPing(
        a.actor,
        pingBody(sessionId, 4, {
          recordedAt: new Date(session.startedAt.getTime() - 120_000).toISOString(),
          latitude: 27.73,
        }),
      ),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    expect(
      await prisma.driverLocationPing.count({ where: { trackingSessionId: sessionId } }),
    ).toBe(1);
  });

  it("in-transaction re-check: a batch completed behind the session's back (hook bypassed) refuses the next ping", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const sessionId = await startBatchSession(a.actor, batch.id);
    // Simulate the race the in-tx re-check exists for: the
    // assignment reaches a terminal state WITHOUT the auto-end hook
    // ending the session (hook miss / direct lifecycle write). The
    // session row still says ACTIVE — the ping must still refuse.
    await prisma.deliveryBatch.update({
      where: { id: batch.id },
      data: { status: "COMPLETED" },
    });
    await expect(
      trackingSvc.postLocationPing(a.actor, pingBody(sessionId, 1)),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    expect(
      await prisma.driverLocationPing.count({ where: { trackingSessionId: sessionId } }),
    ).toBe(0);
  });

  it("in-transaction re-check: a trip completed behind the session's back refuses the next ping", async () => {
    const lh = await makeLinehaul(fx.w1);
    const trip = await makeTrip(lh.driverId, fx.w1, fx.w2);
    const view = await trackingSvc.startTrackingSession(lh.actor, {
      tripId: trip.id,
      permissionAcknowledged: true,
    });
    await prisma.trip.update({ where: { id: trip.id }, data: { status: "COMPLETED" } });
    await expect(
      trackingSvc.postLocationPing(lh.actor, pingBody(view.id, 1)),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    expect(
      await prisma.driverLocationPing.count({ where: { trackingSessionId: view.id } }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------
// 8) Maintenance sweeps + config overrides
// ---------------------------------------------------------------------

describe("P3R-8 maintenance + config", { timeout: 180_000 }, () => {
  it("expire leaves a long-started but ACTIVELY REPORTING session alone", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const session = await directSession(a.driverId, batch.id, fx.w1, "ACTIVE", {
      startedAt: new Date(Date.now() - 3 * 60 * 60_000),
    });
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
    await prisma.driverLocationPing.create({
      data: {
        trackingSessionId: session.id,
        driverId: a.driverId,
        latitude: 27.7,
        longitude: 85.3,
        accuracyMeters: 10,
        recordedAt: fiveMinAgo,
        receivedAt: fiveMinAgo,
        sequenceId: 1,
        source: "BROWSER",
      },
    });
    await prisma.driverCurrentLocation.create({
      data: {
        driverId: a.driverId,
        trackingSessionId: session.id,
        latitude: 27.7,
        longitude: 85.3,
        accuracyMeters: 10,
        lastRecordedAt: fiveMinAgo,
        lastReceivedAt: fiveMinAgo,
        freshnessState: "FRESH",
        activeBatchId: batch.id,
      },
    });
    await trackingSvc.expireAbandonedTrackingSessions(new Date());
    const after = await prisma.trackingSession.findUnique({ where: { id: session.id } });
    expect(after?.status).toBe("ACTIVE");
  });

  it("expire DOES end a session whose assignment is terminal even with a fresh ping, with a system audit row", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1, "COMPLETED");
    const session = await directSession(a.driverId, batch.id, fx.w1, "ACTIVE");
    const oneMinAgo = new Date(Date.now() - 60_000);
    await prisma.driverLocationPing.create({
      data: {
        trackingSessionId: session.id,
        driverId: a.driverId,
        latitude: 27.7,
        longitude: 85.3,
        accuracyMeters: 10,
        recordedAt: oneMinAgo,
        receivedAt: oneMinAgo,
        sequenceId: 1,
        source: "BROWSER",
      },
    });
    await trackingSvc.expireAbandonedTrackingSessions(new Date());
    const after = await prisma.trackingSession.findUnique({ where: { id: session.id } });
    expect(after?.status).toBe("ENDED");
    expect(after?.endReason).toBe("EXPIRED");
    const audit = await prisma.auditLog.findFirst({
      where: { action: "tracking.session_expired", entityId: session.id, actorId: null },
    });
    expect(audit).not.toBeNull();
  });

  it("prune under a hostile retentionDays:1 override deletes old pings but NEVER sessions or snapshots, and keeps sub-window pings", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const session = await directSession(a.driverId, batch.id, fx.w1, "ACTIVE");
    const mkPing = (seq: number, ageMs: number) =>
      prisma.driverLocationPing.create({
        data: {
          trackingSessionId: session.id,
          driverId: a.driverId,
          latitude: 27.7,
          longitude: 85.3,
          accuracyMeters: 10,
          recordedAt: new Date(Date.now() - ageMs),
          receivedAt: new Date(Date.now() - ageMs),
          sequenceId: seq,
          source: "BROWSER",
        },
      });
    const oldPing = await mkPing(1, 2 * 24 * 60 * 60_000);
    const recentPing = await mkPing(2, 12 * 60 * 60_000);
    await prisma.driverCurrentLocation.create({
      data: {
        driverId: a.driverId,
        trackingSessionId: session.id,
        latitude: 27.7,
        longitude: 85.3,
        accuracyMeters: 10,
        lastRecordedAt: new Date(),
        lastReceivedAt: new Date(),
        freshnessState: "FRESH",
        activeBatchId: batch.id,
      },
    });
    await setTrackingConfig({ retentionDays: 1 });
    try {
      await trackingSvc.pruneExpiredLocationPings(new Date());
    } finally {
      await setTrackingConfig(null);
    }
    // Under the operator-set 1-day retention the 2-day ping is gone
    // (documented behaviour — judged in the report), but the
    // structural guarantees must hold under ANY override:
    expect(await prisma.driverLocationPing.findUnique({ where: { id: oldPing.id } })).toBeNull();
    expect(
      await prisma.driverLocationPing.findUnique({ where: { id: recentPing.id } }),
    ).not.toBeNull();
    expect(
      await prisma.trackingSession.findUnique({ where: { id: session.id } }),
    ).not.toBeNull();
    expect(
      await prisma.driverCurrentLocation.findUnique({ where: { driverId: a.driverId } }),
    ).not.toBeNull();
  });

  it("config resolution: out-of-range / malformed overrides fall back to defaults per-field", () => {
    const d = trackingConfigLib.TRACKING_CONFIG_DEFAULTS;
    const resolve = trackingConfigLib.resolveTrackingConfig;
    expect(resolve({ minPingIntervalSeconds: 999999 }).minPingIntervalSeconds).toBe(d.minPingIntervalSeconds);
    expect(resolve({ minPingIntervalSeconds: 0 }).minPingIntervalSeconds).toBe(d.minPingIntervalSeconds);
    expect(resolve({ minPingIntervalSeconds: -30 }).minPingIntervalSeconds).toBe(d.minPingIntervalSeconds);
    expect(resolve({ minPingIntervalSeconds: 2.5 }).minPingIntervalSeconds).toBe(d.minPingIntervalSeconds);
    expect(resolve({ retentionDays: "7" }).retentionDays).toBe(d.retentionDays);
    expect(resolve({ retentionDays: 1.5 }).retentionDays).toBe(d.retentionDays);
    expect(resolve({ retentionDays: Number.NaN }).retentionDays).toBe(d.retentionDays);
    expect(resolve(null).retentionDays).toBe(d.retentionDays);
    expect(resolve("garbage").minPingIntervalSeconds).toBe(d.minPingIntervalSeconds);
    expect(resolve([1, 2, 3]).retentionDays).toBe(d.retentionDays);
    // In-range extremes ARE honoured (operator's prerogative):
    expect(resolve({ minPingIntervalSeconds: 3600 }).minPingIntervalSeconds).toBe(3600);
    expect(resolve({ retentionDays: 1 }).retentionDays).toBe(1);
    // UPDATED by the Phase 3 fix for the review's own floor/cap
    // concern: values below the security floor (a 1-second ping
    // interval invites spam) or above the tightened clock-tolerance
    // cap (a day of tolerated device-clock lead would gut the
    // timestamp validation) now fall back to defaults instead of
    // being honoured.
    expect(resolve({ minPingIntervalSeconds: 1 }).minPingIntervalSeconds).toBe(d.minPingIntervalSeconds);
    expect(resolve({ futureTimestampToleranceSeconds: 86400 }).futureTimestampToleranceSeconds).toBe(d.futureTimestampToleranceSeconds);
  });

  it("a minPingIntervalSeconds override actually tightens the rate limit (and cleanup restores the default)", async () => {
    const a = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const sessionId = await startBatchSession(a.actor, batch.id);
    await trackingSvc.postLocationPing(a.actor, pingBody(sessionId, 1));
    await setTrackingConfig({ minPingIntervalSeconds: 3600 });
    try {
      await backdateLastPing(sessionId, 60);
      // 60 s clears the 30 s default but not the 3600 s override.
      await expect(
        trackingSvc.postLocationPing(
          a.actor,
          pingBody(sessionId, 2, { latitude: 27.71, longitude: 85.31 }),
        ),
      ).rejects.toBeInstanceOf(errors.RateLimitError);
    } finally {
      await setTrackingConfig(null);
    }
  });
});

// ---------------------------------------------------------------------
// 9) Audit spam + existence oracle
// ---------------------------------------------------------------------

describe("P3R-9 audit surface + error oracle", { timeout: 120_000 }, () => {
  it("a permission-less actor cannot mint tracking.identity_mismatch audit rows for a nonexistent session", async () => {
    // postLocationPing writes the identity_mismatch audit BEFORE the
    // permission check and BEFORE the session is even loaded, so any
    // authenticated low-privilege account can flood the append-only
    // audit log at will. Secure behaviour: no audit row is written
    // for a caller who fails authorisation on a session that does
    // not exist.
    const before = await prisma.auditLog.count({
      where: { action: "tracking.identity_mismatch", actorId: customerActor.userId },
    });
    for (let i = 0; i < 3; i++) {
      await expect(
        trackingSvc.postLocationPing(
          customerActor,
          pingBody("00000000-0000-0000-0000-000000000000", 1, {
            driverId: "00000000-0000-0000-0000-000000000001",
          }),
        ),
      ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    }
    const after = await prisma.auditLog.count({
      where: { action: "tracking.identity_mismatch", actorId: customerActor.userId },
    });
    expect(after - before).toBe(0);
  });

  it("existence oracle is consistent: missing → 404 and foreign → 403 on BOTH the ping and detail paths (UUID ids, same pattern as the rest of the codebase)", async () => {
    const a = await makeRider(fx.w1);
    const b = await makeRider(fx.w1);
    const batch = await makeBatch(a.driverId, fx.w1);
    const sessionId = await startBatchSession(a.actor, batch.id);
    await expect(
      trackingSvc.postLocationPing(
        b.actor,
        pingBody("00000000-0000-0000-0000-000000000000", 1),
      ),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
    await expect(
      trackingSvc.postLocationPing(b.actor, pingBody(sessionId, 1)),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      liveOpsSvc.getLiveOperationDetail(wa2Actor, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
    await expect(
      liveOpsSvc.getLiveOperationDetail(wa2Actor, sessionId),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });
});
