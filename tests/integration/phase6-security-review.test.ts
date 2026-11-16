import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hash } from "bcryptjs";
import type { PrismaClient } from "@prisma/client";

// INDEPENDENT Phase 6 security review — adversarial PoCs.
// Every test asserts the DEFENCE. A failing test therefore means the
// attack succeeded and is reported as a finding (see review report).
// `server-only` throws outside a React Server Component environment.
vi.mock("server-only", () => ({}));

function readDevDatabaseUrl(): string {
  for (const file of [".env.local", "prisma/.env"]) {
    try {
      const text = readFileSync(path.resolve(process.cwd(), file), "utf8");
      const match = text.match(/^DATABASE_URL=(.+)$/m);
      if (match) return match[1].trim().replace(/^["']|["']$/g, "");
    } catch {
      // try the next file
    }
  }
  throw new Error("DATABASE_URL not found in .env.local or prisma/.env");
}

const devUrl = readDevDatabaseUrl();
if (new URL(devUrl).pathname !== "/bla_dev") {
  throw new Error(
    "Integration tests require DATABASE_URL to target bla_dev (it is rewritten to bla_test).",
  );
}
const marker = "/bla_dev";
const idx = devUrl.lastIndexOf(marker);
process.env.DATABASE_URL =
  devUrl.slice(0, idx) + "/bla_test" + devUrl.slice(idx + marker.length);

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const RUN_NUM = String(Math.floor(Math.random() * 90000) + 10000);
const email = (label: string) => `p6sr-${label}-${RUN}@test.local`;
const phone = (n: number) =>
  `97797${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);
const PASSWORD = "fixture-password-1";

let prisma: PrismaClient;
let usersSvc: typeof import("@/server/services/users");
let settingsSvc: typeof import("@/server/services/system-settings");
let invSvc: typeof import("@/server/services/invitations");
let whHomeSvc: typeof import("@/server/services/warehouse-home");
let homeSvc: typeof import("@/server/services/home-dashboards");
let finHomeSvc: typeof import("@/server/services/finance-home");
let supHomeSvc: typeof import("@/server/services/support-home");
let auditSvc: typeof import("@/server/services/audit-log");
let incidentsSvc: typeof import("@/server/services/incidents");
let customersSvc: typeof import("@/server/services/customers");
let bookingsSvc: typeof import("@/server/services/bookings");
let custodySvc: typeof import("@/server/services/custody");
let deliveriesSvc: typeof import("@/server/services/deliveries");
let warehousesSvc: typeof import("@/server/services/warehouses");
let vehiclesSvc: typeof import("@/server/services/vehicles");
let errors: typeof import("@/lib/errors");
let actorLib: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");
let trackingLib: typeof import("@/lib/bookings/tracking");
let reportsDomain: typeof import("@/lib/reports/domain");

const fx: Record<string, string> = {};
let whA: string;
let whB: string;
let districtA: string;
let districtB: string;
let serviceCode: string;
let riderADriverId: string;
let riderBDriverId: string;
let batchDateStr: string;

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
  const [vendorLink, customerProfile, driver] = await Promise.all([
    prisma.vendorUser.findFirst({
      where: { userId: user.id, isActive: true, vendor: { isActive: true } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.customer.findUnique({ where: { userId: user.id } }),
    prisma.driver.findUnique({ where: { userId: user.id } }),
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
    driverId: driver?.id ?? null,
    customerId: customerProfile?.id ?? null,
    landingPath: catalog.landingPathForRoles(roles as never[]),
  };
}

async function makeUser(label: string, roleCode: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: `P6SR ${label} ${RUN}`,
      passwordHash: await hash("fixture-password", 10),
      status: "ACTIVE",
    },
  });
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  if (!role) throw new Error(`role ${roleCode} not seeded in bla_test`);
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user.id;
}

async function addMembership(userId: string, warehouseId: string, roleCode: string) {
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  await prisma.warehouseMembership.create({
    data: { userId, warehouseId, roleId: role!.id, isPrimary: true },
  });
}

async function makeWarehouse(prefix: string): Promise<string> {
  for (let n = 10; n < 100; n++) {
    try {
      const wh = await prisma.warehouse.create({
        data: {
          code: `WH-${prefix}-${n}`,
          name: `P6SR ${prefix} Warehouse`,
          type: "REGIONAL",
          district: "Kathmandu",
          city: "Kathmandu",
          province: "Bagmati",
          status: "ACTIVE",
        },
      });
      return wh.id;
    } catch (e) {
      if ((e as { code?: string })?.code !== "P2002") throw e;
    }
  }
  throw new Error("no warehouse code available");
}

async function makeOrder(label: string, customerId?: string): Promise<string> {
  const order = await prisma.order.create({
    data: {
      orderNumber: `P6SR-${RUN}-${label}`,
      customerId: customerId ?? null,
      createdById: fx.admin,
      createdByRole: "ADMIN",
      senderName: `Sender ${label}`,
      senderPhone: phone(7),
      destinationDistrict: "Kathmandu",
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-P6SR-${RUN}-${label}`,
      orderId: order.id,
      originWarehouseId: whA,
      routeKind: "LAST_MILE",
      shippingServiceId: fx.service,
      shippingChargePaisa: BigInt(15000),
    },
  });
  return order.id;
}

async function makePackage(orderId: string, recipientCustomerId?: string): Promise<string> {
  const shipment = await prisma.shipment.findFirst({ where: { orderId } });
  const pkg = await prisma.package.create({
    data: {
      trackingId: trackingLib.generateTrackingId(),
      shipmentId: shipment!.id,
      orderId,
      recipientName: "Fixture Recipient",
      recipientPhone: phone(9),
      recipientCustomerId: recipientCustomerId ?? null,
      deliveryAddress: "Thamel",
      deliveryCity: "Kathmandu",
      deliveryDistrict: "Kathmandu",
      declaredWeightKg: "1.000",
      description: "Fixture parcel",
      operationalStatus: "BOOKED",
      deliveryStatus: "NOT_STARTED",
    },
  });
  return pkg.id;
}

function bookingInput(
  pickup: {
    method: "WAREHOUSE_DROPOFF" | "RIDER_PICKUP";
    originWarehouseId?: string | null;
    vendorAddressId?: string | null;
  },
  extra: Record<string, unknown> = {},
) {
  return {
    sender: { name: "P6SR Sender", phone: phone(42), email: null },
    recipient: {
      name: "P6SR Recipient",
      phone: phone(101),
      addressLine: "Some Street 1",
      city: "Kathmandu",
      district: districtA,
      province: "Bagmati",
    },
    pickup,
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa: "0",
    items: [{ description: "Parcel", quantity: 1, weightKg: 1.0 }],
    ...extra,
  };
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/db/prisma"));
  usersSvc = await import("@/server/services/users");
  settingsSvc = await import("@/server/services/system-settings");
  invSvc = await import("@/server/services/invitations");
  whHomeSvc = await import("@/server/services/warehouse-home");
  homeSvc = await import("@/server/services/home-dashboards");
  finHomeSvc = await import("@/server/services/finance-home");
  supHomeSvc = await import("@/server/services/support-home");
  auditSvc = await import("@/server/services/audit-log");
  incidentsSvc = await import("@/server/services/incidents");
  customersSvc = await import("@/server/services/customers");
  bookingsSvc = await import("@/server/services/bookings");
  custodySvc = await import("@/server/services/custody");
  deliveriesSvc = await import("@/server/services/deliveries");
  warehousesSvc = await import("@/server/services/warehouses");
  vehiclesSvc = await import("@/server/services/vehicles");
  errors = await import("@/lib/errors");
  actorLib = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");
  trackingLib = await import("@/lib/bookings/tracking");
  reportsDomain = await import("@/lib/reports/domain");

  const permissionIdByCode = new Map<string, string>();
  for (const permission of catalog.PERMISSIONS) {
    const row = await prisma.permission.upsert({
      where: { code: permission.code },
      update: { name: permission.name, module: permission.module },
      create: { code: permission.code, name: permission.name, module: permission.module },
    });
    permissionIdByCode.set(permission.code, row.id);
  }
  for (const roleDef of catalog.ROLES) {
    const role = await prisma.role.upsert({
      where: { code: roleDef.code },
      update: { name: roleDef.name },
      create: { code: roleDef.code, name: roleDef.name },
    });
    for (const code of catalog.ROLE_PERMISSIONS[roleDef.code]) {
      const permissionId = permissionIdByCode.get(code);
      if (!permissionId) continue;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        update: {},
        create: { roleId: role.id, permissionId },
      });
    }
  }

  fx.sa1 = await makeUser("sa1", "SUPER_ADMIN");
  fx.sa2 = await makeUser("sa2", "SUPER_ADMIN");
  fx.sa3 = await makeUser("sa3", "SUPER_ADMIN");
  fx.admin = await makeUser("admin", "ADMIN");
  fx.finance = await makeUser("finance", "FINANCE");
  fx.support = await makeUser("support", "SUPPORT");
  fx.waA = await makeUser("wa-a", "WAREHOUSE_ADMIN");
  fx.waB = await makeUser("wa-b", "WAREHOUSE_ADMIN");
  fx.staffA = await makeUser("staff-a", "WAREHOUSE_STAFF");
  // WA role granted with NO warehouse membership (reachable via the new
  // Phase 6 setUserRoles surface, which grants roles without memberships).
  fx.waNoMember = await makeUser("wa-nomember", "WAREHOUSE_ADMIN");
  fx.riderAUser = await makeUser("rider-a", "RIDER");
  fx.riderBUser = await makeUser("rider-b", "RIDER");

  whA = await makeWarehouse("SRA");
  whB = await makeWarehouse("SRB");
  await addMembership(fx.waA, whA, "WAREHOUSE_ADMIN");
  await addMembership(fx.waB, whB, "WAREHOUSE_ADMIN");
  await addMembership(fx.staffA, whA, "WAREHOUSE_STAFF");

  districtA = `P6SR District A ${RUN}`;
  districtB = `P6SR District B ${RUN}`;
  await prisma.serviceArea.create({
    data: { name: "P6SR Area A", district: districtA, city: "Kathmandu", province: "Bagmati", servingWarehouseId: whA },
  });
  await prisma.serviceArea.create({
    data: { name: "P6SR Area B", district: districtB, city: "Kathmandu", province: "Bagmati", servingWarehouseId: whB },
  });

  serviceCode = `P6SR${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P6SR Standard", estimatedDaysMin: 1, estimatedDaysMax: 3 },
  });
  fx.service = service.id;
  await prisma.pricingRule.create({
    data: {
      shippingServiceId: service.id,
      baseRatePaisa: BigInt(15000),
      perKgRatePaisa: BigInt(5000),
      volumetricDivisor: 5000,
      createdById: fx.admin,
    },
  });

  // Drivers: rider A homed at A; rider B homed at B and ON_DELIVERY
  // (an "active driver" for the admin-home global count).
  const mkDriver = async (userId: string, home: string, availability: string, label: string) =>
    (
      await prisma.driver.create({
        data: {
          userId,
          homeWarehouseId: home,
          licenseNumber: `LIC-P6SR-${label}-${RUN}`,
          licenseExpiry: new Date("2030-01-01"),
          employmentStatus: "ACTIVE",
          availabilityStatus: availability,
        },
      })
    ).id;
  riderADriverId = await mkDriver(fx.riderAUser, whA, "AVAILABLE", "a");
  riderBDriverId = await mkDriver(fx.riderBUser, whB, "ON_DELIVERY", "b");

  // Warehouse-home fixtures: one open incident + one overdue task per warehouse.
  const mkIncident = (n: string, warehouseId: string) =>
    prisma.incident.create({
      data: {
        incidentNumber: `INC-P6SR-${RUN}-${n}`,
        category: "DAMAGED_PACKAGE",
        severity: "HIGH",
        status: "REPORTED",
        description: `P6SR fixture incident ${n}`,
        reporterId: fx.admin,
        warehouseId,
      },
    });
  fx.incidentA = (await mkIncident("A", whA)).id;
  fx.incidentB = (await mkIncident("B", whB)).id;
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await prisma.task.create({
    data: { title: `P6SR overdue task A ${RUN}`, createdById: fx.admin, assigneeId: fx.waA, warehouseId: whA, status: "ASSIGNED", dueAt: yesterday },
  });
  await prisma.task.create({
    data: { title: `P6SR overdue task B ${RUN}`, createdById: fx.admin, assigneeId: fx.waB, warehouseId: whB, status: "ASSIGNED", dueAt: yesterday },
  });

  // Customers A/B (sender/recipient split for the incident alignment PoC).
  for (const label of ["custA", "custB"] as const) {
    const userId = await makeUser(label, "CUSTOMER");
    fx[`${label}User`] = userId;
    const customer = await prisma.customer.create({
      data: {
        fullName: `P6SR ${label}`,
        phone: phone(label === "custA" ? 31 : 32),
        normalizedPhone: phone(label === "custA" ? 31 : 32),
        email: email(label),
        userId,
      },
    });
    fx[label] = customer.id;
  }
  // Order SENT by custB, package addressed TO custA.
  fx.orderSenderB = await makeOrder("SB", fx.custB);
  fx.pkgToA = await makePackage(fx.orderSenderB, fx.custA);
  fx.orderSenderA = await makeOrder("SA", fx.custA);

  // Incident reported by Admin, linked to B's order AND A's package.
  const divergence = await prisma.incident.create({
    data: {
      incidentNumber: `INC-P6SR-${RUN}-DIV`,
      category: "PAYMENT_DISPUTE",
      severity: "MEDIUM",
      status: "REPORTED",
      description: "P6SR divergence probe incident",
      reporterId: fx.admin,
      packageId: fx.pkgToA,
      orderId: fx.orderSenderB,
    },
  });
  fx.divergenceIncident = divergence.id;

  // Rider fixtures: a batch today for rider A with one IN_PROGRESS
  // assignment, and an open custody row naming rider A as custodian.
  batchDateStr = reportsDomain.kathmanduToday();
  const batch = await prisma.deliveryBatch.create({
    data: {
      riderId: riderADriverId,
      warehouseId: whA,
      batchDate: new Date(`${batchDateStr}T00:00:00.000Z`),
      kind: "DELIVERY",
      status: "IN_PROGRESS",
      createdById: fx.admin,
    },
  });
  await prisma.deliveryAssignment.create({
    data: { packageId: fx.pkgToA, driverId: riderADriverId, batchId: batch.id, kind: "DELIVERY", status: "IN_PROGRESS", assignedById: fx.admin },
  });
  await prisma.packageCustody.create({
    data: { packageId: fx.pkgToA, custodianType: "USER", custodianUserId: fx.riderAUser },
  });

  // Vendor with an approved PICKUP address in district B (served by whB).
  const vendor = await prisma.vendor.create({
    data: {
      businessName: `P6SR Vendor ${RUN}`,
      contactName: "Vendor Contact",
      email: email("vendor"),
      phone: phone(21),
      verificationStatus: "APPROVED",
      createdById: fx.admin,
    },
  });
  fx.vendor = vendor.id;
  const address = await prisma.vendorAddress.create({
    data: {
      vendorId: vendor.id,
      kind: "PICKUP",
      addressLine1: "Vendor Warehouse 1",
      city: "Kathmandu",
      district: districtB,
      province: "Bagmati",
      isApproved: true,
    },
  });
  fx.vendorAddress = address.id;

  // Vehicle homed at B (fleet scope PoC).
  const vehicle = await prisma.vehicle.create({
    data: { registration: `P6SR-VEH-${RUN}`, type: "VAN", homeWarehouseId: whB, status: "AVAILABLE" },
  });
  fx.vehicleB = vehicle.id;
}, 120_000);

afterAll(async () => {
  // Restore shared settings rows to documented defaults.
  await prisma.systemSetting.upsert({
    where: { key: "session.idle_timeout.staff_hours" },
    update: { value: 24 },
    create: { key: "session.idle_timeout.staff_hours", value: 24 },
  });
  await prisma.systemSetting.upsert({
    where: { key: "session.idle_timeout.privileged_hours" },
    update: { value: 12 },
    create: { key: "session.idle_timeout.privileged_hours", value: 12 },
  });
  await prisma.systemSetting.upsert({
    where: { key: "auth.mfa_required_for_privileged" },
    update: { value: true },
    create: { key: "auth.mfa_required_for_privileged", value: true },
  });
  await prisma.systemSetting.deleteMany({ where: { key: "tracking.config" } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------
describe("1. dashboard metric scoping", () => {
  it("WA-A warehouse home contains only A's figures (no B incident/task)", async () => {
    const home = await whHomeSvc.getWarehouseHomeSummary(await actorFor(fx.waA), whA);
    expect(home.needsAttention.openIncidents).toBe(1);
    expect(home.needsAttention.incidents.map((i) => i.id)).toEqual([fx.incidentA]);
    const serialized = JSON.stringify(home);
    expect(serialized).not.toContain(`INC-P6SR-${RUN}-B`);
    expect(serialized).not.toContain(`P6SR overdue task B ${RUN}`);
  }, 30_000);

  it("WA-A is denied warehouse B's home (audited)", async () => {
    await expect(
      whHomeSvc.getWarehouseHomeSummary(await actorFor(fx.waA), whB),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
  }, 30_000);

  it("DEFENCE: FINANCE (warehouse.read_all, no membership) is refused the warehouse home of B", async () => {
    await expect(
      whHomeSvc.getWarehouseHomeSummary(await actorFor(fx.finance), whB),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
  }, 30_000);

  it("DEFENCE: SUPPORT (warehouse.read_all, no membership) is refused the warehouse home of B", async () => {
    await expect(
      whHomeSvc.getWarehouseHomeSummary(await actorFor(fx.support), whB),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
  }, 30_000);

  it("DEFENCE: WA-A calling getAdminHome is refused (global-role read)", async () => {
    await expect(homeSvc.getAdminHome(await actorFor(fx.waA))).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
  }, 30_000);

  it("FINANCE is refused the live-operations summary (no operations.live_view)", async () => {
    await expect(
      homeSvc.getLiveOperationsSummary(await actorFor(fx.finance)),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
  }, 30_000);

  it("finance/support home gates refuse WA and each other", async () => {
    const wa = await actorFor(fx.waA);
    await expect(finHomeSvc.getFinanceHome(wa)).rejects.toBeInstanceOf(actorLib.AuthorizationError);
    await expect(supHomeSvc.getSupportHome(wa)).rejects.toBeInstanceOf(actorLib.AuthorizationError);
    await expect(supHomeSvc.getSupportHome(await actorFor(fx.finance))).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
    await expect(finHomeSvc.getFinanceHome(await actorFor(fx.support))).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
  }, 30_000);

  it("staff My Work shows only the staff member's own warehouse", async () => {
    const work = await homeSvc.getStaffMyWork(await actorFor(fx.staffA));
    expect(work.perWarehouse.map((w) => w.warehouseId)).toEqual([whA]);
    expect(JSON.stringify(work)).not.toContain(whB);
  }, 30_000);

  it("rider B's home + custody exclude rider A entirely; a non-driver gets no rider home", async () => {
    const b = await actorFor(fx.riderBUser);
    const home = await deliveriesSvc.getRiderHomeToday(b, batchDateStr);
    expect(home.assigned).toBe(0);
    expect(JSON.stringify(home)).not.toContain(fx.pkgToA);
    const custody = await custodySvc.listMyCustody(b);
    expect(custody.map((c) => c.packageId)).not.toContain(fx.pkgToA);
    const aCustody = await custodySvc.listMyCustody(await actorFor(fx.riderAUser));
    expect(aCustody.map((c) => c.packageId)).toContain(fx.pkgToA);
    await expect(
      deliveriesSvc.getRiderHomeToday(await actorFor(fx.waA), batchDateStr),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
  }, 30_000);
});

// ---------------------------------------------------------------------
describe("2. users & roles surface", () => {
  it("listUsers/getUserDetail never project password hash, MFA secret or token material", async () => {
    const secretMarker = `P6SR-MFA-MARKER-${RUN}`;
    await prisma.user.update({
      where: { id: fx.staffA },
      data: { mfaEnabled: true, mfaSecretEncrypted: secretMarker },
    });
    const sa = await actorFor(fx.sa1);
    const detail = await usersSvc.getUserDetail(sa, fx.staffA);
    const list = await usersSvc.listUsers(sa, { search: RUN, pageSize: 100 });
    const staffRow = await prisma.user.findUnique({ where: { id: fx.staffA } });
    for (const payload of [JSON.stringify(detail), JSON.stringify(list.items)]) {
      expect(payload).not.toContain("passwordHash");
      expect(payload).not.toContain("mfaSecret");
      expect(payload).not.toContain("tokenHash");
      expect(payload).not.toContain(secretMarker);
      expect(payload).not.toContain(staffRow!.passwordHash!);
    }
    expect(detail.hasPassword).toBe(true);
    expect(detail.mfaEnrolled).toBe(true);
  }, 30_000);

  it("DEFENCE: an ADMIN cannot reactivate a suspended Super Admin (suspendUser has this guard; reactivate must too)", async () => {
    const sa1 = await actorFor(fx.sa1);
    const targetSa = await makeUser("sa-reactivate-target", "SUPER_ADMIN");
    await usersSvc.suspendUser(sa1, targetSa);
    let outcome = "denied";
    try {
      await usersSvc.reactivateUser(await actorFor(fx.admin), targetSa);
      outcome = "reactivated-by-admin";
    } catch {
      outcome = "denied";
    } finally {
      const row = await prisma.user.findUnique({ where: { id: targetSa } });
      if (row?.status === "ACTIVE") {
        await usersSvc.suspendUser(sa1, targetSa).catch(() => undefined);
      }
    }
    expect(outcome).toBe("denied");
  }, 30_000);

  it("the last active Super Admin cannot be suspended away (self-suspend + Admin-on-SA both refused)", async () => {
    const sa1 = await actorFor(fx.sa1);
    const other = await makeUser("sa-suspend-peer", "SUPER_ADMIN");
    // SA1 suspends the peer — allowed, SA1 remains active.
    await usersSvc.suspendUser(sa1, other);
    // Admin cannot suspend a Super Admin target.
    await expect(usersSvc.suspendUser(await actorFor(fx.admin), fx.sa1)).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
    // Self-suspension is refused.
    await expect(usersSvc.suspendUser(sa1, fx.sa1)).rejects.toBeInstanceOf(
      errors.DomainValidationError,
    );
    await usersSvc.reactivateUser(sa1, other);
  }, 30_000);

  it("ADMIN self-assigns a warehouse membership (no privilege gain: already unscoped) but WA-A cannot self-assign into B", async () => {
    const admin = await actorFor(fx.admin);
    const adminRow = await prisma.user.findUnique({ where: { id: fx.admin } });
    const view = await warehousesSvc.assignMember(admin, whA, {
      email: adminRow!.email,
      roleCode: "WAREHOUSE_ADMIN",
    });
    expect(view.userId).toBe(fx.admin);
    const after = await actorFor(fx.admin);
    // Judged by-design: ADMIN's primary role and global scope are unchanged;
    // the membership grants nothing ADMIN did not already hold.
    expect(after.primaryRole).toBe("ADMIN");
    expect(after.permissions.has("role.manage")).toBe(false);
    expect(after.permissions.has("settings.manage")).toBe(false);

    const waA = await actorFor(fx.waA);
    await expect(
      warehousesSvc.assignMember(waA, whB, { email: adminRow!.email, roleCode: "WAREHOUSE_STAFF" }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
  }, 30_000);
});

// ---------------------------------------------------------------------
describe("3. settings writes", () => {
  it("WA and FINANCE cannot write settings (settings.manage is SA-only)", async () => {
    await expect(
      settingsSvc.updateSetting(await actorFor(fx.waA), "session.idle_timeout.staff_hours", 10),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
    await expect(
      settingsSvc.updateSetting(await actorFor(fx.finance), "auth.mfa_required_for_privileged", false),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
    await expect(settingsSvc.listSettings(await actorFor(fx.finance))).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
  }, 30_000);

  it("type-confusion values are rejected: string/boolean/null hours, truthy MFA flags", async () => {
    const sa = await actorFor(fx.sa1);
    for (const bad of ["24", -5, true, null, Number.NaN]) {
      await expect(
        settingsSvc.updateSetting(sa, "session.idle_timeout.staff_hours", bad as never),
      ).rejects.toBeInstanceOf(errors.DomainValidationError);
    }
    for (const bad of [1, "true", "yes", null]) {
      await expect(
        settingsSvc.updateSetting(sa, "auth.mfa_required_for_privileged", bad as never),
      ).rejects.toBeInstanceOf(errors.DomainValidationError);
    }
    await expect(
      settingsSvc.updateSetting(sa, "tracking.config", { retentionDays: 1_000_000_000 }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      settingsSvc.updateSetting(sa, "tracking.config", { retentionDays: "45" }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
  }, 30_000);

  it("DEFENCE: tracking.config patch cannot smuggle unknown keys via Object.prototype names (toString/constructor)", async () => {
    const sa = await actorFor(fx.sa1);
    let outcome = "rejected";
    try {
      await settingsSvc.updateSetting(sa, "tracking.config", { toString: 42 } as never);
      outcome = "accepted";
    } catch {
      outcome = "rejected";
    }
    const stored = await prisma.systemSetting.findUnique({ where: { key: "tracking.config" } });
    const storedHasJunk =
      stored?.value !== null &&
      typeof stored?.value === "object" &&
      Object.prototype.hasOwnProperty.call(stored.value, "toString");
    await prisma.systemSetting.deleteMany({ where: { key: "tracking.config" } });
    expect(outcome).toBe("rejected");
    expect(storedHasJunk).toBe(false);
  }, 30_000);

  it("a valid MFA toggle writes an audit row with before/after (and is restored)", async () => {
    const sa = await actorFor(fx.sa1);
    try {
      const updated = await settingsSvc.updateSetting(sa, "auth.mfa_required_for_privileged", false);
      expect(updated.value).toBe(false);
      const audit = await prisma.auditLog.findFirst({
        where: { action: "settings.updated", entityId: "auth.mfa_required_for_privileged" },
        orderBy: { createdAt: "desc" },
      });
      expect((audit?.before as { value?: boolean })?.value).toBe(true);
      expect((audit?.after as { value?: boolean })?.value).toBe(false);
    } finally {
      await settingsSvc.updateSetting(sa, "auth.mfa_required_for_privileged", true);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------
describe("4. four-eyes invitation flow", () => {
  it("double-approval race: exactly one approver wins and exactly one approval audit row exists", async () => {
    const sa1 = await actorFor(fx.sa1);
    const created = await invSvc.createInvitation(sa1, { email: email("race-admin"), roleCode: "ADMIN" });
    const [r2, r3] = await Promise.allSettled([
      invSvc.approveInvitation(await actorFor(fx.sa2), created.invitationId),
      invSvc.approveInvitation(await actorFor(fx.sa3), created.invitationId),
    ]);
    const fulfilled = [r2, r3].filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const audits = await prisma.auditLog.count({
      where: { action: "user.invitation_approved", entityId: created.invitationId },
    });
    expect(audits).toBe(1);
    const row = await prisma.userInvitation.findUnique({ where: { id: created.invitationId } });
    expect(row?.status).toBe("PENDING");
  }, 30_000);

  it("self-rejection is refused and audited, WA approval is refused, reject-after-approve is refused", async () => {
    const sa1 = await actorFor(fx.sa1);
    const created = await invSvc.createInvitation(sa1, { email: email("self-reject"), roleCode: "ADMIN" });
    await expect(invSvc.rejectInvitation(sa1, created.invitationId, "mine")).rejects.toBeInstanceOf(
      errors.DomainValidationError,
    );
    const denial = await prisma.auditLog.findFirst({
      where: { actorId: fx.sa1, action: "access.denied", entityId: created.invitationId },
      orderBy: { createdAt: "desc" },
    });
    expect((denial?.after as { reason?: string })?.reason).toBe("invitation_self_approval");

    await expect(
      invSvc.approveInvitation(await actorFor(fx.waA), created.invitationId),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);

    await invSvc.approveInvitation(await actorFor(fx.sa2), created.invitationId);
    await expect(
      invSvc.rejectInvitation(await actorFor(fx.sa3), created.invitationId),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
  }, 30_000);

  it("invitedById cannot be spoofed through the create input", async () => {
    const sa1 = await actorFor(fx.sa1);
    const created = await invSvc.createInvitation(sa1, {
      email: email("spoof"),
      roleCode: "WAREHOUSE_STAFF",
      warehouseId: whA,
      invitedById: fx.admin,
    } as never);
    const row = await prisma.userInvitation.findUnique({ where: { id: created.invitationId } });
    expect(row?.invitedById).toBe(fx.sa1);
  }, 30_000);

  it("DEFENCE: an invitation that expired while PENDING_APPROVAL cannot be approved (and never redeemed)", async () => {
    const sa1 = await actorFor(fx.sa1);
    const created = await invSvc.createInvitation(sa1, { email: email("expired-admin"), roleCode: "ADMIN" });
    await prisma.userInvitation.update({
      where: { id: created.invitationId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    let approveOutcome = "denied";
    try {
      await invSvc.approveInvitation(await actorFor(fx.sa2), created.invitationId);
      approveOutcome = "approved-after-expiry";
    } catch {
      approveOutcome = "denied";
    }
    // Regardless of the approval outcome, redemption must refuse.
    await expect(
      invSvc.acceptInvitation({ token: created.token, fullName: "Expired Admin", password: PASSWORD }),
    ).rejects.toThrow(invSvc.INVITATION_GENERIC_REFUSAL);
    expect(approveOutcome).toBe("denied");
  }, 30_000);

  it("WA scoped inviter stays confined (P2-1): no ADMIN invite, no staff invite into B", async () => {
    const waA = await actorFor(fx.waA);
    await expect(
      invSvc.createInvitation(waA, { email: email("wa-mints-admin"), roleCode: "ADMIN" }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
    await expect(
      invSvc.createInvitation(waA, {
        email: email("wa-staff-b"),
        roleCode: "WAREHOUSE_STAFF",
        warehouseId: whB,
      }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
  }, 30_000);
});

// ---------------------------------------------------------------------
describe("5. vendor/customer isolation in new surfaces", () => {
  it("DEFENCE: listIncidents alignment does not widen past incidentVisibleTo — custB must not list an incident on their order whose package belongs to custA and which they did not report", async () => {
    const b = await actorFor(fx.custBUser);
    // The single-record rule refuses custB (package recipient is A, reporter is Admin).
    await expect(incidentsSvc.getIncident(b, fx.divergenceIncident)).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
    const list = await incidentsSvc.listIncidents(b, { page: 1, pageSize: 50 });
    expect(list.items.map((i) => i.id)).not.toContain(fx.divergenceIncident);
  }, 30_000);

  it("a recipient-only customer cannot raise a PAYMENT_DISPUTE on the sender's order (refused + audited)", async () => {
    const a = await actorFor(fx.custAUser);
    await expect(
      incidentsSvc.createIncident(a, {
        category: "PAYMENT_DISPUTE",
        description: "Dispute raised by the recipient on someone else's order.",
        orderId: fx.orderSenderB,
      }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
    const audit = await prisma.auditLog.findFirst({
      where: { actorId: fx.custAUser, action: "access.denied", entityType: "Incident" },
      orderBy: { createdAt: "desc" },
    });
    expect((audit?.after as { reason?: string } | null)?.reason).toBe("order_not_own_customer");
  }, 30_000);

  it("getOwnCustomerProfile: FINANCE actor with invoice.read but no customer link is refused; the owner reads only their own record", async () => {
    await expect(
      customersSvc.getOwnCustomerProfile(await actorFor(fx.finance)),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
    const profile = await customersSvc.getOwnCustomerProfile(await actorFor(fx.custAUser));
    expect(profile.id).toBe(fx.custA);
  }, 30_000);
});

// ---------------------------------------------------------------------
describe("6. WA booking create scope", () => {
  it("WA-A drop-off at B is refused (builder control, re-attacked)", async () => {
    await expect(
      bookingsSvc.createBooking(
        await actorFor(fx.waA),
        bookingInput({ method: "WAREHOUSE_DROPOFF", originWarehouseId: whB }),
      ),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
  }, 30_000);

  it("DEFENCE: a WA-role holder with NO membership cannot drop off at any warehouse (empty membership must mean no scope, not unscoped)", async () => {
    let outcome = "denied";
    try {
      const booking = await bookingsSvc.createBooking(
        await actorFor(fx.waNoMember),
        bookingInput({ method: "WAREHOUSE_DROPOFF", originWarehouseId: whB }),
      );
      outcome = `created:${booking.originWarehouseId}`;
    } catch {
      outcome = "denied";
    }
    expect(outcome).toBe("denied");
  }, 30_000);

  it("DEFENCE: WA-A cannot create a vendor RIDER_PICKUP booking whose derived origin is warehouse B", async () => {
    let outcome = "denied";
    try {
      const booking = await bookingsSvc.createBooking(
        await actorFor(fx.waA),
        bookingInput(
          { method: "RIDER_PICKUP", vendorAddressId: fx.vendorAddress },
          { vendorId: fx.vendor },
        ),
      );
      outcome = `created:${booking.originWarehouseId}`;
    } catch {
      outcome = "denied";
    }
    expect(outcome).toBe("denied");
  }, 30_000);
});

// ---------------------------------------------------------------------
describe("7. audit log viewer scoping", () => {
  it("WA filters cannot widen scope: entityId of a B row, warehouseId=B, and actorSearch for B's admin all return nothing extra", async () => {
    const probe = `phase6sr.probe.${RUN}`;
    await prisma.auditLog.createMany({
      data: [
        { actorId: fx.sa1, actorRole: "SUPER_ADMIN", action: probe, entityType: "Probe", entityId: `row-a-${RUN}`, warehouseId: whA },
        { actorId: fx.waB, actorRole: "WAREHOUSE_ADMIN", action: probe, entityType: "Probe", entityId: `row-b-${RUN}`, warehouseId: whB },
        { actorId: fx.sa1, actorRole: "SUPER_ADMIN", action: probe, entityType: "Probe", entityId: `row-global-${RUN}`, warehouseId: null },
      ],
    });
    const wa = await actorFor(fx.waA);
    const mine = await auditSvc.listAuditLogs(wa, { action: probe, pageSize: 100 });
    expect(mine.items.map((i) => i.entityId)).toEqual([`row-a-${RUN}`]);

    const byEntity = await auditSvc.listAuditLogs(wa, { entityId: `row-b-${RUN}`, pageSize: 100 });
    expect(byEntity.total).toBe(0);
    const byGlobalEntity = await auditSvc.listAuditLogs(wa, { entityId: `row-global-${RUN}`, pageSize: 100 });
    expect(byGlobalEntity.total).toBe(0);
    const byWarehouse = await auditSvc.listAuditLogs(wa, { action: probe, warehouseId: whB, pageSize: 100 });
    expect(byWarehouse.total).toBe(0);
    const waBName = (await prisma.user.findUnique({ where: { id: fx.waB } }))!.fullName;
    const byActor = await auditSvc.listAuditLogs(wa, { actorSearch: waBName, pageSize: 100 });
    expect(byActor.items.every((i) => i.warehouseId === whA)).toBe(true);
    expect(byActor.items.map((i) => i.entityId)).not.toContain(`row-b-${RUN}`);
  }, 30_000);

  it("action+outcome composition cannot be overwritten into a leak; FINANCE (audit.read, no memberships) sees no scoped rows", async () => {
    const wa = await actorFor(fx.waA);
    const contradictory = await auditSvc.listAuditLogs(wa, {
      action: "access.denied",
      outcome: "recorded",
      pageSize: 100,
    });
    expect(contradictory.total).toBe(0);
    const combined = await auditSvc.listAuditLogs(wa, {
      warehouseId: whB,
      outcome: "denied",
      actorSearch: RUN,
      pageSize: 100,
    });
    expect(combined.total).toBe(0);
    const fin = await auditSvc.listAuditLogs(await actorFor(fx.finance), {
      action: `phase6sr.probe.${RUN}`,
      pageSize: 100,
    });
    expect(fin.total).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------
describe("8. fleet assign split (Phase 6 surface for WA)", () => {
  it("DEFENCE: WA-A cannot assign a driver to a vehicle homed at warehouse B", async () => {
    let outcome = "denied";
    try {
      await vehiclesSvc.assignVehicleDriver(await actorFor(fx.waA), fx.vehicleB, riderBDriverId);
      outcome = "assigned";
    } catch {
      outcome = "denied";
    } finally {
      await prisma.vehicle.update({ where: { id: fx.vehicleB }, data: { assignedDriverId: null } });
    }
    expect(outcome).toBe("denied");
  }, 30_000);

  it("WA-A still cannot change vehicle status (vehicle.manage stays Admin/SA)", async () => {
    await expect(
      vehiclesSvc.setVehicleStatus(await actorFor(fx.waA), fx.vehicleB, "MAINTENANCE"),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
  }, 30_000);
});
