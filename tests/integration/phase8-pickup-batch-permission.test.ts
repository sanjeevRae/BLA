import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 8 — createDeliveryBatch permission gate by batch kind
 * (closing the Phase 7 minor): a PICKUP batch requires
 * pickup.assign, a DELIVERY batch (including the no-kind default)
 * requires delivery.assign. Previously every batch required
 * delivery.assign, so a pickup-only operator could not open a
 * PICKUP batch at all.
 *
 * Actors with a single assign permission are built the way the
 * Phase 3/5/7 suites build permission-specific actors: the real
 * warehouse-admin actor (membership scope intact) with its
 * permission set narrowed to exactly one permission.
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
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const email = (label: string) => `p8pb-${label}-${RUN}@bla.test`;
const TODAY = new Date().toISOString().slice(0, 10);

let prisma: import("@prisma/client").PrismaClient;
let deliveriesSvc: typeof import("@/server/services/deliveries");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

type Actor = Awaited<ReturnType<typeof actorFor>>;

const fx: Record<string, string> = {};
let waActor: Actor;
let pickupOnlyActor: Actor;
let deliveryOnlyActor: Actor;

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
      fullName: `P8PB ${label}`,
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

const batchInput = (kind?: "PICKUP" | "DELIVERY") => ({
  warehouseId: fx.wh,
  riderUserId: fx.riderUser,
  batchDate: TODAY,
  ...(kind ? { kind } : {}),
});

async function batchCount(kind: string): Promise<number> {
  return prisma.deliveryBatch.count({
    where: { warehouseId: fx.wh, createdById: fx.waUser, kind },
  });
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
  deliveriesSvc = await import("@/server/services/deliveries");
  actorErrors = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");

  // Permission catalog into bla_test (same upserts as the seed).
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

  const warehouse = await prisma.warehouse.create({
    data: {
      code: `P8PB-${RUN}`,
      name: `P8PB Warehouse ${RUN}`,
      status: "ACTIVE",
      district: "Kathmandu",
      city: "Kathmandu",
      province: "Bagmati",
    },
  });
  fx.wh = warehouse.id;

  fx.adminUser = await makeUser("admin", "ADMIN");

  fx.waUser = await makeUser("wa", "WAREHOUSE_ADMIN");
  await addMembership(fx.waUser, fx.wh, "WAREHOUSE_ADMIN");
  waActor = await actorFor(fx.waUser);
  expect(waActor.permissions.has("pickup.assign")).toBe(true);
  expect(waActor.permissions.has("delivery.assign")).toBe(true);

  // The rider is eligible for BOTH kinds (both capabilities), so
  // the only gate that can refuse a creation below is the actor's
  // assign permission.
  fx.riderUser = await makeUser("rider", "RIDER");
  const driver = await prisma.driver.create({
    data: {
      userId: fx.riderUser,
      homeWarehouseId: fx.wh,
      licenseNumber: `LIC-P8PB-${RUN}`,
      licenseExpiry: new Date("2028-01-01"),
    },
  });
  await prisma.driverCapability.createMany({
    data: [
      { driverId: driver.id, capability: "DELIVERY" },
      { driverId: driver.id, capability: "PICKUP" },
    ],
  });

  pickupOnlyActor = { ...waActor, permissions: new Set(["pickup.assign"]) };
  deliveryOnlyActor = { ...waActor, permissions: new Set(["delivery.assign"]) };
});

describe("Phase 8 — createDeliveryBatch gate by kind", () => {
  it("an actor holding ONLY pickup.assign creates a PICKUP batch but is refused a DELIVERY batch", async () => {
    const pickup = await deliveriesSvc.createDeliveryBatch(
      pickupOnlyActor,
      batchInput("PICKUP"),
    );
    expect(pickup.kind).toBe("PICKUP");
    expect(pickup.status).toBe("OPEN");

    const before = await batchCount("DELIVERY");
    await expect(
      deliveriesSvc.createDeliveryBatch(pickupOnlyActor, batchInput("DELIVERY")),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    // The no-kind default resolves to DELIVERY before the gate, so
    // it is refused for a pickup-only actor too.
    await expect(
      deliveriesSvc.createDeliveryBatch(pickupOnlyActor, batchInput()),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    expect(await batchCount("DELIVERY")).toBe(before);
  });

  it("an actor holding ONLY delivery.assign creates a DELIVERY batch but is refused a PICKUP batch", async () => {
    const delivery = await deliveriesSvc.createDeliveryBatch(
      deliveryOnlyActor,
      batchInput("DELIVERY"),
    );
    expect(delivery.kind).toBe("DELIVERY");
    expect(delivery.status).toBe("OPEN");

    const defaulted = await deliveriesSvc.createDeliveryBatch(
      deliveryOnlyActor,
      batchInput(),
    );
    expect(defaulted.kind).toBe("DELIVERY");

    const before = await batchCount("PICKUP");
    await expect(
      deliveriesSvc.createDeliveryBatch(deliveryOnlyActor, batchInput("PICKUP")),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    expect(await batchCount("PICKUP")).toBe(before);
  });

  it("existing role flows are unaffected: the full warehouse-admin role creates both kinds", async () => {
    const pickup = await deliveriesSvc.createDeliveryBatch(waActor, batchInput("PICKUP"));
    expect(pickup.kind).toBe("PICKUP");
    const delivery = await deliveriesSvc.createDeliveryBatch(
      waActor,
      batchInput("DELIVERY"),
    );
    expect(delivery.kind).toBe("DELIVERY");
  });
});
