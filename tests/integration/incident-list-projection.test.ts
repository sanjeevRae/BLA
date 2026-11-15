import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Regression test for the P8-R1 sibling closed in the Phase 9 fix
 * batch: listIncidents must apply the SAME customer-safe projection
 * as getIncident. Raiser-side viewers (vendors / customers) see
 * status, category, severity, description and timestamps — never
 * the resolution text or staff identities — while full-view actors
 * (incident.manage holders, staff reporter/assignee) keep the base
 * view on the list path too.
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
const RUN_NUM = String(Math.floor(Math.random() * 90000) + 10000);
const email = (label: string) => `p9f-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);

let prisma: import("@prisma/client").PrismaClient;
let bookingsSvc: typeof import("@/server/services/bookings");
let vendorsSvc: typeof import("@/server/services/vendors");
let incidentsSvc: typeof import("@/server/services/incidents");
let catalog: typeof import("@/lib/permissions/catalog");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let staffActor: Awaited<ReturnType<typeof actorFor>>;
let vendorOwnerActor: Awaited<ReturnType<typeof actorFor>>;
let incidentId: string;

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
      fullName: `P9F ${label}`,
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
  bookingsSvc = await import("@/server/services/bookings");
  vendorsSvc = await import("@/server/services/vendors");
  incidentsSvc = await import("@/server/services/incidents");
  catalog = await import("@/lib/permissions/catalog");

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

  fx.adminUser = await makeUser("admin", "ADMIN");
  adminActor = await actorFor(fx.adminUser);

  // One warehouse + service area + priced service for a booking.
  const district = `P9F District ${RUN}`;
  let warehouse: { id: string; code: string } | null = null;
  for (let attempt = 0; attempt < 40 && !warehouse; attempt += 1) {
    const nn = String(Math.floor(Math.random() * 90) + 10);
    const code = `WH-ZF9-${nn}`;
    const existing = await prisma.warehouse.findUnique({ where: { code } });
    if (existing) continue;
    warehouse = await prisma.warehouse.create({
      data: {
        code,
        name: `P9F Hub ${RUN}`,
        type: "REGIONAL",
        status: "ACTIVE",
        district,
        city: "P9F City",
        province: "Bagmati",
        country: "Nepal",
        capacityPackages: 100,
      },
    });
  }
  if (!warehouse) throw new Error("could not allocate a fixture warehouse code");
  fx.wh = warehouse.id;
  await prisma.serviceArea.create({
    data: {
      name: `P9F Area ${RUN}`,
      district,
      city: "P9F City",
      province: "Bagmati",
      servingWarehouseId: warehouse.id,
    },
  });
  const serviceCode = `P9FSTD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P9F Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
  });
  await prisma.pricingRule.create({
    data: {
      shippingServiceId: service.id,
      baseRatePaisa: BigInt(15000),
      perKgRatePaisa: BigInt(5000),
      volumetricDivisor: 5000,
      createdById: fx.adminUser,
    },
  });
  fx.serviceCode = serviceCode;
  fx.district = district;

  // Warehouse staff (the incident reporter) with a membership.
  fx.staffUser = await makeUser("staff", "WAREHOUSE_STAFF");
  const staffRole = await prisma.role.findUnique({ where: { code: "WAREHOUSE_STAFF" } });
  await prisma.warehouseMembership.create({
    data: {
      userId: fx.staffUser,
      warehouseId: warehouse.id,
      roleId: staffRole!.id,
      isPrimary: true,
      assignedById: fx.adminUser,
    },
  });
  staffActor = await actorFor(fx.staffUser);

  // Approved vendor + its owner user.
  const vendor = await vendorsSvc.createVendor(adminActor, {
    businessName: `P9F Vendor ${RUN}`,
    contactName: "P9F Contact",
    email: email("vendor"),
    phone: phone(11),
    billingPreference: "COD_OFFSET",
    creditLimitPaisa: null,
    registrationNumber: null,
  });
  await vendorsSvc.setVendorVerificationStatus(adminActor, vendor.id, {
    target: "UNDER_REVIEW",
    notes: null,
  });
  await vendorsSvc.setVendorVerificationStatus(adminActor, vendor.id, {
    target: "APPROVED",
    notes: null,
  });
  fx.vendor = vendor.id;
  fx.vendorOwnerUser = await makeUser("vendorOwner", "VENDOR");
  await prisma.vendorUser.create({
    data: {
      userId: fx.vendorOwnerUser,
      vendorId: vendor.id,
      vendorRole: "OWNER",
      isActive: true,
      invitedById: fx.adminUser,
    },
  });
  vendorOwnerActor = await actorFor(fx.vendorOwnerUser);

  // A booking for the vendor → a package to hang the incident on.
  const booking = await bookingsSvc.createBooking(adminActor, {
    vendorId: vendor.id,
    sender: { name: "P9F Sender", phone: phone(42), email: null },
    recipient: {
      name: "P9F Recipient",
      phone: phone(101),
      addressLine: "Street 1",
      city: "Town",
      district,
      province: "Bagmati",
    },
    pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId: warehouse.id },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa: "0",
    items: [{ description: "Parcel", quantity: 1, weightKg: 1.0 }],
  });
  const pkg = booking.shipments[0].packages[0];

  // Staff raise the incident; then give it an assignee and a
  // resolution directly at the row level — the lifecycle is not
  // what this test exercises, the list VIEW projection is.
  const incident = await incidentsSvc.createIncident(staffActor, {
    category: "DAMAGED_PACKAGE",
    description: "Parcel arrived with a crushed corner",
    packageId: pkg.id,
  });
  incidentId = incident.id;
  await prisma.incident.update({
    where: { id: incident.id },
    data: {
      status: "RESOLVED",
      resolution: "INTERNAL-ONLY: courier admitted deliberate damage; HR case opened",
      assigneeId: fx.adminUser,
      resolvedAt: new Date(),
    },
  });
}, 120_000);

describe("listIncidents customer-safe projection (P8-R1 sibling)", () => {
  it("vendor list items withhold resolution text and staff identities", async () => {
    const list = await incidentsSvc.listIncidents(vendorOwnerActor, { pageSize: 100 });
    const item = list.items.find((i) => i.id === incidentId);
    expect(item).toBeTruthy();
    // The summary fields stay visible…
    expect(item!.status).toBe("RESOLVED");
    expect(item!.category).toBe("DAMAGED_PACKAGE");
    expect(item!.severity).toBeTruthy();
    expect(item!.description).toContain("crushed corner");
    expect(item!.createdAt).toBeTruthy();
    // …the internal fields do not.
    expect(item!.resolution).toBeNull();
    expect(item!.reporterName).toBeNull();
    expect(item!.assigneeId).toBeNull();
    expect(item!.assigneeName).toBeNull();
    expect(JSON.stringify(item)).not.toContain("INTERNAL-ONLY");
  });

  it("admin list items keep the full base view", async () => {
    // mine:true — the admin is the incident's assignee; this also
    // keeps the shared test DB's accumulated incidents out of the way.
    const list = await incidentsSvc.listIncidents(adminActor, { mine: true, pageSize: 100 });
    const item = list.items.find((i) => i.id === incidentId);
    expect(item).toBeTruthy();
    expect(item!.resolution).toContain("INTERNAL-ONLY");
    expect(item!.reporterName).toBe("P9F staff");
    expect(item!.assigneeId).toBe(fx.adminUser);
    expect(item!.assigneeName).toBe("P9F admin");
  });

  it("the staff reporter keeps the full view of their own incident in the list", async () => {
    const list = await incidentsSvc.listIncidents(staffActor, { mine: true, pageSize: 100 });
    const item = list.items.find((i) => i.id === incidentId);
    expect(item).toBeTruthy();
    expect(item!.resolution).toContain("INTERNAL-ONLY");
    expect(item!.reporterName).toBe("P9F staff");
  });
});
