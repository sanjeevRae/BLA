import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Step 7 (V3) — Customer home read model against bla_test:
 *  - two customers with packages; each model contains exactly its
 *    own figures and none of the other's tracking IDs (both
 *    directions);
 *  - current shipments come from the direct own-scope query:
 *    expectedDeliveryAt is the planted Shipment.expectedDeliveryAt
 *    for the in-transit parcel and null for the attempted parcel
 *    whose shipment carries none; currentLocationLabel names the
 *    planted current warehouse, null when the parcel is not at one;
 *  - returned counts ReturnRequests whose package is addressed to
 *    the customer (listReturns has no customer branch);
 *  - SERIALISED-MODEL KEY SCAN: the whole model must not match
 *    /latitude|longitude|coord|driverName|driverPhone|recipientPhone|deliveryAddress/i.
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
const RUN_NUM = String(Math.floor(Math.random() * 90000) + 10000);
const email = (label: string) => `s7c-${label}-${RUN}@bla.test`;
const EXPECTED_AT = new Date("2026-12-01T00:00:00.000Z");

let prisma: import("@prisma/client").PrismaClient;
let homeSvc: typeof import("@/server/services/home-dashboards");
let catalog: typeof import("@/lib/permissions/catalog");

type Actor = Awaited<ReturnType<typeof actorFor>>;

const fx: Record<string, string> = {};
let customerAActor: Actor;
let customerBActor: Actor;

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
      fullName: `S7C ${label}`,
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

async function makeOrderWithShipment(
  label: string,
  expectedDeliveryAt: Date | null,
): Promise<{ orderId: string; shipmentId: string }> {
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-S7C-${label}-${RUN}`,
      createdById: fx.adminUser,
      createdByRole: "ADMIN",
      senderName: `Sender ${label}`,
      senderPhone: "9779811111111",
      destinationDistrict: "Kathmandu",
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  const shipment = await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-S7C-${label}-${RUN}`,
      orderId: order.id,
      originWarehouseId: fx.warehouse,
      routeKind: "LAST_MILE",
      shippingServiceId: fx.service,
      shippingChargePaisa: BigInt(15000),
      expectedDeliveryAt,
    },
  });
  return { orderId: order.id, shipmentId: shipment.id };
}

async function makePackage(input: {
  label: string;
  orderId: string;
  shipmentId: string;
  recipientCustomerId: string;
  operationalStatus: string;
  deliveryStatus?: string;
  currentWarehouseId?: string;
}): Promise<{ id: string; trackingId: string }> {
  const pkg = await prisma.package.create({
    data: {
      trackingId: `BLA-S7C-${input.label}-${RUN}`,
      shipmentId: input.shipmentId,
      orderId: input.orderId,
      recipientName: `Recipient ${input.label}`,
      recipientPhone: "9779800000300",
      recipientCustomerId: input.recipientCustomerId,
      deliveryAddress: `Address ${input.label}`,
      deliveryCity: "Kathmandu",
      deliveryDistrict: "Kathmandu",
      declaredWeightKg: "1.000",
      description: `Parcel ${input.label}`,
      operationalStatus: input.operationalStatus,
      deliveryStatus: input.deliveryStatus ?? "NOT_STARTED",
      currentWarehouseId: input.currentWarehouseId ?? null,
    },
  });
  return { id: pkg.id, trackingId: pkg.trackingId };
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
  homeSvc = await import("@/server/services/home-dashboards");
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

  const warehouse = await prisma.warehouse.create({
    data: {
      code: `S7C-${RUN}`,
      name: `S7C Central ${RUN}`,
      district: "Kathmandu",
      city: "Kathmandu",
      province: "Bagmati",
      status: "ACTIVE",
    },
  });
  fx.warehouse = warehouse.id;
  fx.warehouseName = warehouse.name;
  const service = await prisma.shippingService.create({
    data: { code: `S7CSVC-${RUN}`, name: `S7C Service ${RUN}` },
  });
  fx.service = service.id;

  fx.adminUser = await makeUser("admin", "ADMIN");

  // Two customers, each linked to a CUSTOMER user.
  for (const label of ["custA", "custB"] as const) {
    const userId = await makeUser(label, "CUSTOMER");
    fx[`${label}User`] = userId;
    const customer = await prisma.customer.create({
      data: {
        fullName: `S7C ${label}`,
        phone: label === "custA" ? `9779800${RUN_NUM}1` : `9779800${RUN_NUM}2`,
        normalizedPhone: label === "custA" ? `9779800${RUN_NUM}1` : `9779800${RUN_NUM}2`,
        email: email(label),
        userId,
      },
    });
    fx[label] = customer.id;
  }
  customerAActor = await actorFor(fx.custAUser);
  customerBActor = await actorFor(fx.custBUser);

  // Customer A: in-transit parcel (shipment HAS an estimate, parcel is
  // AT the warehouse), attempted parcel (shipment has NO estimate,
  // parcel not at a warehouse), delivered parcel, delivered parcel
  // with a return.
  const legT = await makeOrderWithShipment("AT", EXPECTED_AT);
  const pkgATransit = await makePackage({
    label: "AT",
    orderId: legT.orderId,
    shipmentId: legT.shipmentId,
    recipientCustomerId: fx.custA,
    operationalStatus: "IN_TRANSIT",
    currentWarehouseId: fx.warehouse,
  });
  const legA = await makeOrderWithShipment("AA", null);
  const pkgAAttempted = await makePackage({
    label: "AA",
    orderId: legA.orderId,
    shipmentId: legA.shipmentId,
    recipientCustomerId: fx.custA,
    operationalStatus: "DELIVERY_ATTEMPTED",
  });
  const legD = await makeOrderWithShipment("AD", null);
  const pkgADelivered = await makePackage({
    label: "AD",
    orderId: legD.orderId,
    shipmentId: legD.shipmentId,
    recipientCustomerId: fx.custA,
    operationalStatus: "DELIVERED",
    deliveryStatus: "DELIVERED",
  });
  const legR = await makeOrderWithShipment("AR", null);
  const pkgAReturned = await makePackage({
    label: "AR",
    orderId: legR.orderId,
    shipmentId: legR.shipmentId,
    recipientCustomerId: fx.custA,
    operationalStatus: "DELIVERED",
    deliveryStatus: "DELIVERED",
  });
  fx.trackingA = [pkgATransit.trackingId, pkgAAttempted.trackingId, pkgADelivered.trackingId, pkgAReturned.trackingId].join(",");
  fx.trackingATransit = pkgATransit.trackingId;
  fx.trackingAAttempted = pkgAAttempted.trackingId;
  await prisma.returnRequest.create({
    data: {
      returnNumber: `RET-S7C-A-${RUN}`,
      packageId: pkgAReturned.id,
      shipmentId: legR.shipmentId,
      orderId: legR.orderId,
      warehouseId: fx.warehouse,
      reason: "OTHER",
      status: "REQUESTED",
      requestedById: fx.adminUser,
    },
  });

  // Customer B: one in-transit parcel + a return on it.
  const legB = await makeOrderWithShipment("B1", null);
  const pkgB = await makePackage({
    label: "B1",
    orderId: legB.orderId,
    shipmentId: legB.shipmentId,
    recipientCustomerId: fx.custB,
    operationalStatus: "IN_TRANSIT",
  });
  fx.trackingB = pkgB.trackingId;
  await prisma.returnRequest.create({
    data: {
      returnNumber: `RET-S7C-B-${RUN}`,
      packageId: pkgB.id,
      shipmentId: legB.shipmentId,
      orderId: legB.orderId,
      warehouseId: fx.warehouse,
      reason: "OTHER",
      status: "REQUESTED",
      requestedById: fx.adminUser,
    },
  });

  // Support: one open ticket per customer.
  for (const [label, customerId, userId] of [
    ["A", fx.custA, fx.custAUser],
    ["B", fx.custB, fx.custBUser],
  ] as const) {
    await prisma.supportTicket.create({
      data: {
        ticketNumber: `TKT-S7C-${label}-${RUN}`,
        category: "GENERAL",
        status: "OPEN",
        subject: `S7C ticket ${label} ${RUN}`,
        description: `Ticket for customer ${label}`,
        raisedById: userId,
        customerId,
      },
    });
  }

  // Billing for A: one unpaid ISSUED invoice (10_000) and one
  // CANCELLED invoice that must not count as unpaid.
  await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-S7C-A-${RUN}`,
      customerId: fx.custA,
      subtotalPaisa: BigInt(10000),
      totalPaisa: BigInt(10000),
      status: "ISSUED",
      issuedById: fx.adminUser,
      lines: {
        create: [{ kind: "SHIPPING_CHARGE", description: "Fixture charge A", amountPaisa: BigInt(10000) }],
      },
    },
  });
  await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-S7C-AX-${RUN}`,
      customerId: fx.custA,
      subtotalPaisa: BigInt(99999),
      totalPaisa: BigInt(99999),
      status: "CANCELLED",
      issuedById: fx.adminUser,
    },
  });

  // One in-app notification for A's user.
  await prisma.notification.create({
    data: {
      userId: fx.custAUser,
      category: "OUT_FOR_DELIVERY",
      channel: "IN_APP",
      title: `S7C update ${RUN}`,
      body: "Your parcel is on its way.",
    },
  });
}, 120_000);

describe("Step 7 — customer home model", () => {
  it("metrics equal the planted truth for customer A", async () => {
    const model = await homeSvc.getCustomerHome(customerAActor);
    expect(model.metrics).toEqual({
      total: 4,
      inTransit: 1,
      outForDelivery: 0,
      delivered: 2,
      returned: 1,
    });
    expect(model.attention.deliveryAttempted).toBe(1);
    expect(model.attention.openTickets).toBe(1);
    expect(model.attention.unpaidInvoices).toBe(1);
    expect(model.attention.unpaidTotalPaisa).toBe("10000");
    expect(model.attemptedShipments.map((s) => s.trackingId)).toEqual([fx.trackingAAttempted]);
  });

  it("current shipments carry the planted estimate and warehouse label exactly", async () => {
    const model = await homeSvc.getCustomerHome(customerAActor);
    const byTracking = new Map(model.currentShipments.map((s) => [s.trackingId, s]));
    expect([...byTracking.keys()].sort()).toEqual(
      [fx.trackingATransit, fx.trackingAAttempted].sort(),
    );
    const transit = byTracking.get(fx.trackingATransit)!;
    expect(transit.expectedDeliveryAt).toBe(EXPECTED_AT.toISOString());
    expect(transit.currentLocationLabel).toBe(`${fx.warehouseName}, Kathmandu`);
    const attempted = byTracking.get(fx.trackingAAttempted)!;
    expect(attempted.expectedDeliveryAt).toBeNull();
    expect(attempted.currentLocationLabel).toBeNull();
  });

  it("recent deliveries and notifications are A's own", async () => {
    const model = await homeSvc.getCustomerHome(customerAActor);
    expect(model.recentDeliveries).toHaveLength(2);
    for (const row of model.recentDeliveries) {
      expect(fx.trackingA.split(",")).toContain(row.trackingId);
      expect(row.lastUpdateAt).toBeTruthy();
    }
    expect(model.recentNotifications).toHaveLength(1);
    expect(model.recentNotifications![0].title).toBe(`S7C update ${RUN}`);
  });

  it("customer B's model has B's figures and none of A's tracking IDs", async () => {
    const modelB = await homeSvc.getCustomerHome(customerBActor);
    expect(modelB.metrics).toEqual({
      total: 1,
      inTransit: 1,
      outForDelivery: 0,
      delivered: 0,
      returned: 1,
    });
    expect(modelB.attention.openTickets).toBe(1);
    expect(modelB.attention.unpaidInvoices).toBe(0);
    expect(modelB.currentShipments.map((s) => s.trackingId)).toEqual([fx.trackingB]);

    const serialisedB = JSON.stringify(modelB);
    for (const trackingId of fx.trackingA.split(",")) {
      expect(serialisedB).not.toContain(trackingId);
    }
    const serialisedA = JSON.stringify(await homeSvc.getCustomerHome(customerAActor));
    expect(serialisedA).not.toContain(fx.trackingB);
  });

  it("serialised model contains no coordinates, driver, phone or address keys", async () => {
    const model = await homeSvc.getCustomerHome(customerAActor);
    const serialised = JSON.stringify(model);
    expect(serialised).not.toMatch(
      /latitude|longitude|coord|driverName|driverPhone|recipientPhone|deliveryAddress/i,
    );
    const modelB = await homeSvc.getCustomerHome(customerBActor);
    expect(JSON.stringify(modelB)).not.toMatch(
      /latitude|longitude|coord|driverName|driverPhone|recipientPhone|deliveryAddress/i,
    );
  });

  it("an unlinked actor is refused", async () => {
    const unlinked = { ...customerAActor, customerId: null };
    await expect(homeSvc.getCustomerHome(unlinked as never)).rejects.toThrow(/customer/);
  });
});
