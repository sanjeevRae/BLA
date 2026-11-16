import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * INDEPENDENT SECURITY REVIEW — Phase 5 (V2) live operations.
 * Adversarial PoCs for claims 1–8 in the review brief. Fixtures mirror
 * tests/integration/phase5-live-search.test.ts (RUN-unique KTM/PKR
 * warehouses, catalog roles, direct-DB sessions + snapshots), extended
 * with STALE / PAUSED / recent-ENDED / old-ENDED sessions, a COD
 * collection, denied-role actors and synthetic permission sets.
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
const email = (label: string) => `p5r-${label}-${RUN}@bla.test`;

let prisma: import("@prisma/client").PrismaClient;
let liveOpsSvc: typeof import("@/server/services/live-operations");
let catalog: typeof import("@/lib/permissions/catalog");
let registry: typeof import("@/lib/navigation/registry");

type Actor = Awaited<ReturnType<typeof actorFor>>;

const fx: Record<string, string> = {};
let adminActor: Actor;
let waKtmActor: Actor;
const deniedActors: Record<string, Actor> = {};

let pkrTrackingId: string;
let ktmTrackingId: string;
let endedOldTrackingId: string;
let endedRecentTrackingId: string;
const COD_PAISA = "12345";

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

async function makeUser(label: string, roleCode: string, fullName?: string): Promise<string> {
  const { hash } = await import("bcryptjs");
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: fullName ?? `P5R ${label}`,
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
    data: { userId, warehouseId, roleId: role!.id, isPrimary: true, assignedById: fx.adminUser },
  });
}

async function makeDriver(userId: string, homeWarehouseId: string, label: string) {
  const driver = await prisma.driver.create({
    data: {
      userId,
      homeWarehouseId,
      licenseNumber: `LIC-P5R-${label}-${RUN}`,
      licenseExpiry: new Date("2028-01-01"),
    },
  });
  return driver.id;
}

async function makeBatch(riderId: string, warehouseId: string) {
  return prisma.deliveryBatch.create({
    data: {
      riderId,
      warehouseId,
      batchDate: new Date(),
      kind: "DELIVERY",
      status: "OPEN",
      createdById: fx.adminUser,
    },
  });
}

async function makePackage(label: string, trackingId: string) {
  return prisma.package.create({
    data: {
      trackingId,
      shipmentId: fx.shipmentId,
      orderId: fx.orderId,
      recipientName: `RecipientSecret ${label} ${RUN}`,
      recipientPhone: `977980777${label}`,
      deliveryAddress: `SecretAddress ${label} ${RUN}`,
      deliveryCity: "Kathmandu",
      deliveryDistrict: "Kathmandu",
      declaredWeightKg: "1.000",
      description: `Parcel ${label}`,
    },
  });
}

async function assign(driverId: string, batchId: string, pkgId: string) {
  return prisma.deliveryAssignment.create({
    data: {
      packageId: pkgId,
      driverId,
      batchId,
      kind: "DELIVERY",
      status: "IN_PROGRESS",
      assignedById: fx.adminUser,
    },
  });
}

async function makeSession(opts: {
  driverId: string;
  deliveryBatchId?: string;
  tripId?: string;
  trackingType: string;
  originWarehouseId: string;
  destinationWarehouseId?: string;
  status?: string;
  endedAt?: Date;
  receivedAt?: Date;
}) {
  const session = await prisma.trackingSession.create({
    data: {
      driverId: opts.driverId,
      deliveryBatchId: opts.deliveryBatchId ?? null,
      tripId: opts.tripId ?? null,
      trackingType: opts.trackingType,
      originWarehouseId: opts.originWarehouseId,
      destinationWarehouseId: opts.destinationWarehouseId ?? null,
      status: opts.status ?? "ACTIVE",
      startReason: "DRIVER",
      permissionAcknowledgedAt: new Date(),
      endedAt: opts.endedAt ?? null,
    },
  });
  if (opts.receivedAt) {
    await prisma.driverCurrentLocation.create({
      data: {
        driverId: opts.driverId,
        trackingSessionId: session.id,
        latitude: 27.7,
        longitude: 85.3,
        accuracyMeters: 10,
        lastRecordedAt: opts.receivedAt,
        lastReceivedAt: opts.receivedAt,
        freshnessState: "FRESH",
        activeBatchId: opts.deliveryBatchId ?? null,
        activeTripId: opts.tripId ?? null,
      },
    });
  }
  return session.id;
}

/** A batch movement at `warehouseId` for a fresh driver user. */
async function makeMovement(opts: {
  label: string;
  driverName: string;
  warehouseId: string;
  trackingId: string;
  pkgLabel: string;
  status?: string;
  endedAt?: Date;
  receivedAt?: Date;
}) {
  const user = await makeUser(`drv${opts.label}`, "RIDER", opts.driverName);
  const driverId = await makeDriver(user, opts.warehouseId, opts.label);
  const batch = await makeBatch(driverId, opts.warehouseId);
  const pkg = await makePackage(opts.pkgLabel, opts.trackingId);
  const assignment = await assign(driverId, batch.id, pkg.id);
  const sessionId = await makeSession({
    driverId,
    deliveryBatchId: batch.id,
    trackingType: "DELIVERY",
    originWarehouseId: opts.warehouseId,
    status: opts.status,
    endedAt: opts.endedAt,
    receivedAt: opts.receivedAt,
  });
  return { driverId, batchId: batch.id, pkgId: pkg.id, assignmentId: assignment.id, sessionId };
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
  liveOpsSvc = await import("@/server/services/live-operations");
  catalog = await import("@/lib/permissions/catalog");
  registry = await import("@/lib/navigation/registry");

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
        where: { roleId_permissionId: { roleId: roleId.get(role.code)!, permissionId: permissionId.get(code)! } },
        update: {},
        create: { roleId: roleId.get(role.code)!, permissionId: permissionId.get(code)! },
      });
    }
  }

  const wKtm = await prisma.warehouse.create({
    data: { code: `P5RK-${RUN}`.slice(0, 20), name: `P5R KTM ${RUN}`, district: "Kathmandu", city: "Kathmandu", province: "Bagmati" },
  });
  const wPkr = await prisma.warehouse.create({
    data: { code: `P5RP-${RUN}`.slice(0, 20), name: `P5R PKR ${RUN}`, district: "Kaski", city: "Pokhara", province: "Gandaki" },
  });
  fx.wKtm = wKtm.id;
  fx.wPkr = wPkr.id;

  fx.adminUser = await makeUser("admin", "ADMIN");
  adminActor = await actorFor(fx.adminUser);
  const waKtmUser = await makeUser("waktm", "WAREHOUSE_ADMIN");
  fx.waKtmUser = waKtmUser;
  await addMembership(waKtmUser, fx.wKtm, "WAREHOUSE_ADMIN");
  waKtmActor = await actorFor(waKtmUser);

  for (const roleCode of ["WAREHOUSE_STAFF", "RIDER", "LINEHAUL_DRIVER", "VENDOR", "CUSTOMER", "FINANCE", "SUPPORT"]) {
    const uid = await makeUser(`denied${roleCode.toLowerCase()}`, roleCode);
    deniedActors[roleCode] = await actorFor(uid);
  }

  const service = await prisma.shippingService.create({
    data: { code: `P5RSVC-${RUN}`, name: `P5R Service ${RUN}` },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-P5R-${RUN}`,
      createdById: fx.adminUser,
      createdByRole: "ADMIN",
      senderName: "P5R Sender",
      senderPhone: "9779811111111",
      destinationDistrict: "Kathmandu",
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  fx.orderId = order.id;
  const shipment = await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-P5R-${RUN}`,
      orderId: order.id,
      originWarehouseId: fx.wKtm,
      destinationWarehouseId: fx.wPkr,
      routeKind: "INTER_WAREHOUSE",
      shippingServiceId: service.id,
      shippingChargePaisa: BigInt(0),
    },
  });
  fx.shipmentId = shipment.id;

  const now = Date.now();
  ktmTrackingId = `BLA-P5R-KTM-${RUN}`;
  pkrTrackingId = `BLA-P5R-PKR-${RUN}`;
  endedOldTrackingId = `BLA-P5R-OLD-${RUN}`;
  endedRecentTrackingId = `BLA-P5R-REC-${RUN}`;

  const ktm = await makeMovement({
    label: "ktm", driverName: `SecAlpha-${RUN} Driver`, warehouseId: fx.wKtm,
    trackingId: ktmTrackingId, pkgLabel: "11", receivedAt: new Date(now - 60_000),
  });
  fx.sessionKtm = ktm.sessionId;
  fx.batchKtm = ktm.batchId;

  const pkr = await makeMovement({
    label: "pkr", driverName: `SecBeta-${RUN} Driver`, warehouseId: fx.wPkr,
    trackingId: pkrTrackingId, pkgLabel: "22", receivedAt: new Date(now - 60_000),
  });
  fx.sessionPkr = pkr.sessionId;
  fx.batchPkr = pkr.batchId;

  // COD collection on the KTM batch (assignment from makeMovement).
  await prisma.deliveryCodCollection.create({
    data: {
      packageId: ktm.pkgId,
      shipmentId: fx.shipmentId,
      assignmentId: ktm.assignmentId,
      batchId: ktm.batchId,
      expectedPaisa: BigInt(COD_PAISA),
      collectedPaisa: BigInt(COD_PAISA),
      status: "MATCHED",
      collectedById: fx.adminUser,
    },
  });

  const stale = await makeMovement({
    label: "stale", driverName: `SecStale-${RUN} Driver`, warehouseId: fx.wKtm,
    trackingId: `BLA-P5R-STALE-${RUN}`, pkgLabel: "44",
    receivedAt: new Date(now - 3 * 24 * 3600_000),
  });
  fx.sessionStale = stale.sessionId;

  const paused = await makeMovement({
    label: "paused", driverName: `SecPaused-${RUN} Driver`, warehouseId: fx.wKtm,
    trackingId: `BLA-P5R-PAUSED-${RUN}`, pkgLabel: "55",
    status: "PAUSED", receivedAt: new Date(now - 30_000),
  });
  fx.sessionPaused = paused.sessionId;

  const endedRecent = await makeMovement({
    label: "endrecent", driverName: `SecEndRecent-${RUN} Driver`, warehouseId: fx.wKtm,
    trackingId: endedRecentTrackingId, pkgLabel: "66",
    status: "ENDED", endedAt: new Date(now - 10 * 60_000), receivedAt: new Date(now - 12 * 60_000),
  });
  fx.sessionEndedRecent = endedRecent.sessionId;

  const endedOld = await makeMovement({
    label: "endold", driverName: `SecEndOld-${RUN} Driver`, warehouseId: fx.wKtm,
    trackingId: endedOldTrackingId, pkgLabel: "77",
    status: "ENDED", endedAt: new Date(now - 10 * 24 * 3600_000), receivedAt: new Date(now - 10 * 24 * 3600_000),
  });
  fx.sessionEndedOld = endedOld.sessionId;
});

// ------------------------------------------------------------------
// Claim 1 — scope cannot widen
// ------------------------------------------------------------------

describe("P5R claim 1: scope cannot widen", () => {
  it("1a: WA(KTM) passing warehouseId=PKR gets an empty board", async () => {
    const res = await liveOpsSvc.listLiveOperations(waKtmActor, { warehouseId: fx.wPkr });
    expect(res.items).toHaveLength(0);
    expect(res.total).toBe(0);
  });

  it("1b: WA(KTM) search by foreign driver-name fragment returns empty", async () => {
    const res = await liveOpsSvc.listLiveOperations(waKtmActor, { search: `SecBeta-${RUN}` });
    expect(res.items).toHaveLength(0);
  });

  it("1b: WA(KTM) search by foreign package tracking ID returns empty", async () => {
    const res = await liveOpsSvc.listLiveOperations(waKtmActor, { search: pkrTrackingId });
    expect(res.items).toHaveLength(0);
  });

  it("1b: WA(KTM) search by foreign batch-id prefix returns empty", async () => {
    const res = await liveOpsSvc.listLiveOperations(waKtmActor, { search: fx.batchPkr.slice(0, 8) });
    expect(res.items).toHaveLength(0);
    // positive control: own batch prefix DOES match for the same actor
    const own = await liveOpsSvc.listLiveOperations(waKtmActor, { search: fx.batchKtm.slice(0, 8) });
    expect(own.items.some((i) => i.trackingSessionId === fx.sessionKtm)).toBe(true);
  });

  it("1b: LIKE/SQL metacharacters do not widen scope (% _ \\ ' \" injection strings)", async () => {
    const inScopeIds = new Set([fx.sessionKtm, fx.sessionStale, fx.sessionPaused, fx.sessionEndedRecent]);
    for (const probe of ["%", "_", "\\", "'", '"', `' OR '1'='1`, "' OR 1=1 --", "%%"]) {
      const res = await liveOpsSvc.listLiveOperations(waKtmActor, { search: probe });
      for (const item of res.items) {
        expect(inScopeIds.has(item.trackingSessionId)).toBe(true);
      }
    }
  });

  it("1b-FIXED P5-S1: '%' and '_' are literals after escaping — no wildcard match-all", async () => {
    // FINDING (Low, fixed in-phase): Prisma `contains`/`startsWith`
    // pass % and _ through as LIKE pattern metacharacters; before
    // the fix both probes returned the actor's whole in-scope set.
    // The service now escapes LIKE metacharacters in the search
    // term, so both match literally — and no fixture field
    // literally contains % or _ (all use hyphens), so both return
    // nothing. Scope held before and after (nothing foreign leaks
    // either way — see the tests above).
    const pct = await liveOpsSvc.listLiveOperations(waKtmActor, { search: "%" });
    expect(pct.items).toHaveLength(0);
    const und = await liveOpsSvc.listLiveOperations(waKtmActor, { search: "_" });
    expect(und.items).toHaveLength(0);
    const backslash = await liveOpsSvc.listLiveOperations(waKtmActor, { search: "\\" });
    expect(backslash.items).toHaveLength(0);
  });

  it("1b: a 10,000-char search does not throw and does not widen", async () => {
    const res = await liveOpsSvc.listLiveOperations(waKtmActor, { search: "A".repeat(10_000) });
    expect(res.items).toHaveLength(0);
  });

  it("1c: WA(KTM) detail on the foreign (PKR) session is refused AND audited", async () => {
    const before = await prisma.auditLog.count({
      where: { actorId: fx.waKtmUser, action: "access.denied", entityType: "LiveOperation", entityId: fx.sessionPkr },
    });
    await expect(
      liveOpsSvc.getLiveOperationDetail(waKtmActor, fx.sessionPkr),
    ).rejects.toThrow(/outside your assigned scope/i);
    const rows = await prisma.auditLog.findMany({
      where: { actorId: fx.waKtmUser, action: "access.denied", entityType: "LiveOperation", entityId: fx.sessionPkr },
    });
    expect(rows.length).toBe(before + 1);
    expect(JSON.stringify(rows[rows.length - 1].after)).toContain("live_operation_out_of_scope");
    // positive control: own-warehouse detail succeeds
    const own = await liveOpsSvc.getLiveOperationDetail(waKtmActor, fx.sessionKtm);
    expect(own.trackingSessionId).toBe(fx.sessionKtm);
  });
});

// ------------------------------------------------------------------
// Claim 2 — search composes with the status window
// ------------------------------------------------------------------

describe("P5R claim 2: search composes, never replaces", () => {
  it("an ENDED session outside the recent window stays hidden even when its exact package ID is searched by a global actor", async () => {
    const byPkg = await liveOpsSvc.listLiveOperations(adminActor, { search: endedOldTrackingId });
    expect(byPkg.items).toHaveLength(0);
    const byDriver = await liveOpsSvc.listLiveOperations(adminActor, { search: `SecEndOld-${RUN}` });
    expect(byDriver.items).toHaveLength(0);
    const unfiltered = await liveOpsSvc.listLiveOperations(adminActor, { warehouseId: fx.wKtm });
    expect(unfiltered.items.some((i) => i.trackingSessionId === fx.sessionEndedOld)).toBe(false);
  });

  it("control: an ENDED session INSIDE the window is listed (window, not status alone, hides the old one)", async () => {
    const res = await liveOpsSvc.listLiveOperations(adminActor, { search: endedRecentTrackingId });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].trackingSessionId).toBe(fx.sessionEndedRecent);
    expect(res.items[0].sessionStatus).toBe("ENDED");
  });
});

// ------------------------------------------------------------------
// Claim 3 — no recipient PII
// ------------------------------------------------------------------

describe("P5R claim 3: no recipient PII in list/detail payloads", () => {
  const secrets = [
    "RecipientSecret", "977980777", "SecretAddress",
  ];
  function sweep(payload: unknown, label: string) {
    const json = JSON.stringify(payload);
    for (const s of secrets) expect(json, label).not.toContain(s);
    expect(json, label).not.toMatch(/recipientName|recipientPhone|deliveryAddress/i);
  }
  function keySweep(value: unknown) {
    if (Array.isArray(value)) return value.forEach(keySweep);
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        expect(k).not.toMatch(/recipient|phone|address/i);
        keySweep(v);
      }
    }
  }

  it("list payload (global + WA) contains no recipient name/phone/address, in keys or values", async () => {
    for (const actor of [adminActor, waKtmActor]) {
      const res = await liveOpsSvc.listLiveOperations(actor, { warehouseId: fx.wKtm });
      expect(res.items.length).toBeGreaterThan(0);
      sweep(res, "list");
      keySweep(res);
    }
  });

  it("detail payload (global + WA) contains no recipient PII; packages project only id/trackingId/statuses", async () => {
    for (const actor of [adminActor, waKtmActor]) {
      const detail = await liveOpsSvc.getLiveOperationDetail(actor, fx.sessionKtm);
      sweep(detail, "detail");
      keySweep(detail);
      expect(detail.packages).toHaveLength(1);
      expect(Object.keys(detail.packages[0]).sort()).toEqual(
        ["assignmentStatus", "packageId", "packageStatus", "trackingId"].sort(),
      );
      expect(detail.packages[0].trackingId).toBe(ktmTrackingId);
    }
  });

  it("source: the service include tree selects only trackingId + operationalStatus for packages", () => {
    const src = readFileSync(join(process.cwd(), "src/server/services/live-operations.ts"), "utf8");
    expect(src).not.toContain("recipientName");
    expect(src).not.toContain("recipientPhone");
    expect(src).not.toContain("deliveryAddress");
    expect(src).toContain("package: { select: { trackingId: true, operationalStatus: true } }");
  });
});

// ------------------------------------------------------------------
// Claim 4 — COD gating
// ------------------------------------------------------------------

describe("P5R claim 4: COD gating", () => {
  it("catalog facts: WAREHOUSE_ADMIN holds cod.read (NOT finance.read) — so WA legitimately receives COD", async () => {
    expect(catalog.ROLE_PERMISSIONS.WAREHOUSE_ADMIN).toContain("cod.read");
    expect(catalog.ROLE_PERMISSIONS.WAREHOUSE_ADMIN).not.toContain("finance.read");
    expect(waKtmActor.permissions.has("cod.read")).toBe(true);
    const res = await liveOpsSvc.listLiveOperations(waKtmActor, { search: ktmTrackingId });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].codCollectedPaisa).toBe(COD_PAISA);
  });

  it("an actor with operations.live_view but NEITHER finance.read NOR cod.read gets NO codCollectedPaisa key (list + detail, also under search)", async () => {
    const noCod: Actor = {
      ...waKtmActor,
      permissions: new Set([...waKtmActor.permissions].filter((p) => p !== "cod.read" && p !== "finance.read")),
    };
    expect(noCod.permissions.has("operations.live_view")).toBe(true);
    const list = await liveOpsSvc.listLiveOperations(noCod, { search: ktmTrackingId });
    expect(list.items).toHaveLength(1);
    expect("codCollectedPaisa" in list.items[0]).toBe(false);
    expect(JSON.stringify(list)).not.toContain("codCollectedPaisa");
    const detail = await liveOpsSvc.getLiveOperationDetail(noCod, fx.sessionKtm);
    expect("codCollectedPaisa" in detail).toBe(false);
    expect(JSON.stringify(detail)).not.toContain(COD_PAISA);
  });

  it("cod.read alone suffices, and finance.read alone suffices (global synthetic actors)", async () => {
    for (const perm of ["cod.read", "finance.read"]) {
      const actor: Actor = {
        ...adminActor,
        permissions: new Set(["operations.live_view", "warehouse.read_all", perm]),
      };
      const list = await liveOpsSvc.listLiveOperations(actor, { search: ktmTrackingId });
      expect(list.items).toHaveLength(1);
      expect(list.items[0].codCollectedPaisa).toBe(COD_PAISA);
    }
  });
});

// ------------------------------------------------------------------
// Claim 5 — route/nav gating for roles without operations.live_view
// ------------------------------------------------------------------

describe("P5R claim 5: gating for roles without operations.live_view", () => {
  const denied = ["WAREHOUSE_STAFF", "RIDER", "LINEHAUL_DRIVER", "VENDOR", "CUSTOMER", "FINANCE", "SUPPORT"] as const;
  const dashboards = ["super-admin", "admin", "warehouse", "staff", "rider", "transport-driver", "vendor", "customer", "finance", "support"] as const;

  it("registry: no live-operations item is visible to any denied role's catalog permissions in ANY dashboard", () => {
    for (const role of denied) {
      expect(catalog.ROLE_PERMISSIONS[role]).not.toContain("operations.live_view");
      const perms = new Set(catalog.ROLE_PERMISSIONS[role]);
      for (const dash of dashboards) {
        const items = registry.visibleNavItems(perms, dash);
        expect(items.some((i) => i.id.includes("live-operations")), `${role}/${dash}`).toBe(false);
      }
    }
  });

  it("registry: staff dashboard NEVER carries the item even for live_view holders; warehouse dashboard does only with the permission", () => {
    const waPerms = new Set(catalog.ROLE_PERMISSIONS.WAREHOUSE_ADMIN);
    expect(registry.visibleNavItems(waPerms, "staff").some((i) => i.id.includes("live-operations"))).toBe(false);
    expect(registry.visibleNavItems(waPerms, "warehouse").some((i) => i.id === "warehouse:live-operations")).toBe(true);
    const staffPerms = new Set(catalog.ROLE_PERMISSIONS.WAREHOUSE_STAFF);
    expect(registry.visibleNavItems(staffPerms, "warehouse").some((i) => i.id.includes("live-operations"))).toBe(false);
    const adminPerms = new Set(catalog.ROLE_PERMISSIONS.ADMIN);
    expect(registry.visibleNavItems(adminPerms, "admin").some((i) => i.id === "admin:live-operations")).toBe(true);
    expect(registry.visibleNavItems(adminPerms, "super-admin").some((i) => i.id === "super-admin:live-operations")).toBe(true);
  });

  it("service: every denied role is refused by list AND detail (audited gate fires before data)", async () => {
    for (const role of denied) {
      const actor = deniedActors[role];
      await expect(liveOpsSvc.listLiveOperations(actor, { search: ktmTrackingId })).rejects.toThrow();
      await expect(liveOpsSvc.getLiveOperationDetail(actor, fx.sessionKtm)).rejects.toThrow();
    }
  });
});

// ------------------------------------------------------------------
// Claim 6 — requested-scope cookie preselect cannot widen
// ------------------------------------------------------------------

describe("P5R claim 6: cookie preselect / initial warehouse filter cannot widen", () => {
  it("service intersection is the control: WA with warehouseId=PKR + a KTM-matching search still gets only the intersection", async () => {
    const res = await liveOpsSvc.listLiveOperations(waKtmActor, {
      warehouseId: fx.wPkr,
      search: `SecAlpha-${RUN}`,
    });
    expect(res.items).toHaveLength(0);
    const ok = await liveOpsSvc.listLiveOperations(waKtmActor, {
      warehouseId: fx.wKtm,
      search: `SecAlpha-${RUN}`,
    });
    expect(ok.items).toHaveLength(1);
  });

  it("source: board seeds warehouseId state ONLY if the initial value is among the actor's server-provided options", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/live-operations/LiveOperationsBoard.tsx"),
      "utf8",
    );
    expect(src).toContain("initialWarehouseId && warehouseOptions.some((w) => w.id === initialWarehouseId)");
  });
});

// ------------------------------------------------------------------
// Claim 7 — XSS / markup injection into Leaflet divIcon html
// ------------------------------------------------------------------

describe("P5R claim 7: divIcon html injection surface", () => {
  it("pinIcon html interpolates NO driver/warehouse name — only enum classes + a constant letter", () => {
    const src = readFileSync(join(process.cwd(), "src/components/live-operations/LiveMap.tsx"), "utf8");
    const pin = src.slice(src.indexOf("function pinIcon"), src.indexOf("function warehouseIcon"));
    expect(pin).not.toContain("driverName");
    expect(pin).not.toContain("coords");
    expect(pin).toContain("TYPE_LETTER[item.trackingType]");
  });

  it("FIXED P5-S3: warehouseIcon escapes coords.code at the sink (pattern validation remains as defence in depth)", async () => {
    // FINDING (Low, fixed in-phase): warehouseIcon originally
    // interpolated ${coords.code} raw into Leaflet's innerHTML
    // html: string. It now routes the code through escapeHtml.
    // The creation-time pattern + immutable code below remain as
    // the second layer.
    const src = readFileSync(join(process.cwd(), "src/components/live-operations/LiveMap.tsx"), "utf8");
    const wh = src.slice(src.indexOf("function warehouseIcon"), src.indexOf("function fitToPoints"));
    expect(wh).toContain("${escapeHtml(coords.code)}");
    expect(wh).not.toContain("${coords.code}");
    const { WAREHOUSE_CODE_PATTERN } = await import("@/lib/warehouses/codes");
    for (const evil of [`<img src=x onerror=alert(1)>`, `WH-KTM-01<script>`, `" onmouseover="alert(1)`, `WH-KT-01`]) {
      expect(WAREHOUSE_CODE_PATTERN.test(evil)).toBe(false);
    }
    expect(WAREHOUSE_CODE_PATTERN.test("WH-KTM-01")).toBe(true);
    // update path cannot change code at all:
    const whSvc = readFileSync(join(process.cwd(), "src/server/services/warehouses.ts"), "utf8");
    const updateSchema = whSvc.slice(whSvc.indexOf("updateWarehouseSchema"), whSvc.indexOf("UpdateWarehouseInput"));
    expect(updateSchema).not.toContain("code:");
  });
});

// ------------------------------------------------------------------
// Claim 8 — freshness honesty
// ------------------------------------------------------------------

describe("P5R claim 8: freshness honesty", () => {
  it("an ACTIVE session whose last fix is 3 days old reads STALE, never FRESH", async () => {
    const res = await liveOpsSvc.listLiveOperations(adminActor, { search: `SecStale-${RUN}` });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].freshnessState).toBe("STALE");
  });

  it("a PAUSED session with a 30-second-old fix reads OFFLINE, never FRESH", async () => {
    const res = await liveOpsSvc.listLiveOperations(adminActor, { search: `SecPaused-${RUN}` });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].sessionStatus).toBe("PAUSED");
    expect(res.items[0].freshnessState).toBe("OFFLINE");
  });

  it("a recent ENDED session reads OFFLINE (not live-styled); the old ENDED session is absent entirely (no lingering fresh ghost)", async () => {
    const res = await liveOpsSvc.listLiveOperations(adminActor, { search: endedRecentTrackingId });
    expect(res.items[0].freshnessState).toBe("OFFLINE");
    const all = await liveOpsSvc.listLiveOperations(waKtmActor, {});
    expect(all.items.some((i) => i.trackingSessionId === fx.sessionEndedOld)).toBe(false);
    for (const item of all.items) {
      if (item.sessionStatus !== "ACTIVE") expect(item.freshnessState).toBe("OFFLINE");
    }
  });

  it("source: pin CSS gives FRESH the live brand colour only; STALE/OFFLINE are muted/reduced-opacity, and the badge always pairs with last-update text in the board", () => {
    const css = readFileSync(join(process.cwd(), "src/components/live-operations/live-map.css"), "utf8");
    expect(css).toContain(".bla-pin-fresh");
    expect(css).toMatch(/\.bla-pin-stale\s*{[^}]*opacity:\s*0\.55/);
    expect(css).toMatch(/\.bla-pin-offline\s*{[^}]*opacity:\s*0\.6/);
    const board = readFileSync(join(process.cwd(), "src/components/live-operations/LiveOperationsBoard.tsx"), "utf8");
    expect(board).toContain("Last update ${relativeTime(item.location.lastReceivedAt, nowMs)}");
    expect(board).toContain("Waiting for first location");
  });
});
