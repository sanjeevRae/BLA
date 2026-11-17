import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Step 7 (V3) — Vendor home read model against bla_test:
 *  - vendor A's model contains A's figures and NONE of vendor B's
 *    (ids / trackingIds / order numbers / return numbers absent from
 *    the serialised model, both directions);
 *  - metric accuracy against the planted truth: report-range
 *    bookings / delivered / returnsCreated, current package buckets,
 *    COD payable = the vendor-payable ledger balance ("0" — no
 *    ledger activity planted), outstanding = the open invoice total;
 *  - attention counts: delivery attempted, returns awaiting (REQUESTED),
 *    open incidents (vendor branch of listIncidents: package.order.
 *    vendorId) and open tickets (vendor branch of listTickets:
 *    vendorId) each resolve to the vendor's own rows only;
 *  - warehouse assignments come from listVendorAssignments (A has
 *    one, B has none).
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
const email = (label: string) => `s7v-${label}-${RUN}@bla.test`;

let prisma: import("@prisma/client").PrismaClient;
let homeSvc: typeof import("@/server/services/home-dashboards");
let catalog: typeof import("@/lib/permissions/catalog");

type Actor = Awaited<ReturnType<typeof actorFor>>;

const fx: Record<string, string> = {};
let vendorAActor: Actor;
let vendorBActor: Actor;

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
      fullName: `S7V ${label}`,
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

async function makeOrder(label: string, vendorId: string): Promise<string> {
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-S7V-${label}-${RUN}`,
      vendorId,
      createdById: fx.adminUser,
      createdByRole: "ADMIN",
      senderName: `Sender ${label}`,
      senderPhone: "9779811111111",
      destinationDistrict: "Kathmandu",
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-S7V-${label}-${RUN}`,
      orderId: order.id,
      originWarehouseId: fx.warehouse,
      routeKind: "LAST_MILE",
      shippingServiceId: fx.service,
      shippingChargePaisa: BigInt(15000),
    },
  });
  return order.id;
}

async function makePackage(
  label: string,
  orderId: string,
  operationalStatus: string,
  deliveryStatus = "NOT_STARTED",
): Promise<{ id: string; trackingId: string }> {
  const shipment = await prisma.shipment.findFirst({ where: { orderId } });
  if (!shipment) throw new Error("fixture shipment missing");
  const pkg = await prisma.package.create({
    data: {
      trackingId: `BLA-S7V-${label}-${RUN}`,
      shipmentId: shipment.id,
      orderId,
      recipientName: `Recipient ${label}`,
      recipientPhone: "9779800000200",
      deliveryAddress: `Address ${label}`,
      deliveryCity: "Kathmandu",
      deliveryDistrict: "Kathmandu",
      declaredWeightKg: "1.000",
      description: `Parcel ${label}`,
      codAmountPaisa: BigInt(1000),
      operationalStatus,
      deliveryStatus,
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
      code: `S7V-${RUN}`,
      name: `S7V Warehouse ${RUN}`,
      district: "Kathmandu",
      city: "Kathmandu",
      province: "Bagmati",
      status: "ACTIVE",
    },
  });
  fx.warehouse = warehouse.id;
  fx.warehouseCode = warehouse.code;
  const service = await prisma.shippingService.create({
    data: { code: `S7VSVC-${RUN}`, name: `S7V Service ${RUN}` },
  });
  fx.service = service.id;

  fx.adminUser = await makeUser("admin", "ADMIN");
  const driverUser = await makeUser("driver", "RIDER");
  const driver = await prisma.driver.create({
    data: {
      userId: driverUser,
      homeWarehouseId: fx.warehouse,
      licenseNumber: `LIC-S7V-${RUN}`,
      licenseExpiry: new Date("2030-01-01"),
    },
  });
  fx.driver = driver.id;

  // Two vendor organisations with an owner user each.
  for (const label of ["vendorA", "vendorB"] as const) {
    const vendor = await prisma.vendor.create({
      data: {
        businessName: `S7V ${label} ${RUN}`,
        contactName: `${label} Contact`,
        email: email(label),
        phone: "9779800000210",
        verificationStatus: "APPROVED",
        createdById: fx.adminUser,
      },
    });
    fx[label] = vendor.id;
    const ownerId = await makeUser(`${label}-owner`, "VENDOR");
    fx[`${label}Owner`] = ownerId;
    await prisma.vendorUser.create({
      data: { vendorId: vendor.id, userId: ownerId, vendorRole: "OWNER", invitedById: fx.adminUser },
    });
  }
  vendorAActor = await actorFor(fx.vendorAOwner);
  vendorBActor = await actorFor(fx.vendorBOwner);

  // Vendor A is assigned the warehouse; vendor B has no assignment.
  await prisma.vendorWarehouseAssignment.create({
    data: { vendorId: fx.vendorA, warehouseId: fx.warehouse, kind: "ORIGIN", assignedById: fx.adminUser },
  });

  // Vendor A: 2 orders; packages BOOKED / IN_TRANSIT / ATTEMPTED / DELIVERED.
  fx.orderA1 = await makeOrder("A1", fx.vendorA);
  fx.orderA2 = await makeOrder("A2", fx.vendorA);
  const pkgABooked = await makePackage("AB", fx.orderA1, "BOOKED");
  const pkgATransit = await makePackage("AT", fx.orderA1, "IN_TRANSIT");
  const pkgAAttempted = await makePackage("AA", fx.orderA2, "DELIVERY_ATTEMPTED");
  const pkgADelivered = await makePackage("AD", fx.orderA2, "DELIVERED", "DELIVERED");
  fx.trackingA = [pkgABooked.trackingId, pkgATransit.trackingId, pkgAAttempted.trackingId, pkgADelivered.trackingId].join(",");
  fx.trackingAAttempted = pkgAAttempted.trackingId;

  const assignment = await prisma.deliveryAssignment.create({
    data: { packageId: pkgADelivered.id, driverId: fx.driver, assignedById: fx.adminUser, status: "COMPLETED" },
  });
  await prisma.proofOfDelivery.create({
    data: {
      packageId: pkgADelivered.id,
      assignmentId: assignment.id,
      deliveredAt: new Date(),
      recordedById: fx.adminUser,
    },
  });

  const shipmentA2 = await prisma.shipment.findFirst({ where: { orderId: fx.orderA2 } });
  const retA = await prisma.returnRequest.create({
    data: {
      returnNumber: `RET-S7V-A-${RUN}`,
      packageId: pkgADelivered.id,
      shipmentId: shipmentA2!.id,
      orderId: fx.orderA2,
      warehouseId: fx.warehouse,
      reason: "OTHER",
      status: "REQUESTED",
      requestedById: fx.adminUser,
    },
  });
  fx.returnA = retA.returnNumber;

  await prisma.incident.create({
    data: {
      incidentNumber: `INC-S7V-A-${RUN}`,
      category: "DAMAGED_PACKAGE",
      severity: "HIGH",
      status: "REPORTED",
      packageId: pkgATransit.id,
      reporterId: fx.adminUser,
      description: `S7V incident A ${RUN}`,
    },
  });
  await prisma.supportTicket.create({
    data: {
      ticketNumber: `TKT-S7V-A-${RUN}`,
      category: "GENERAL",
      status: "OPEN",
      subject: `S7V ticket A ${RUN}`,
      description: "Vendor A ticket",
      raisedById: fx.vendorAOwner,
      vendorId: fx.vendorA,
    },
  });
  await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-S7V-A-${RUN}`,
      vendorId: fx.vendorA,
      subtotalPaisa: BigInt(50000),
      totalPaisa: BigInt(50000),
      status: "ISSUED",
      issuedById: fx.adminUser,
    },
  });

  // Vendor B: 1 order; packages BOOKED / ATTEMPTED; one REQUESTED return,
  // one open ticket, NO incident, NO warehouse assignment.
  fx.orderB1 = await makeOrder("B1", fx.vendorB);
  const pkgBBooked = await makePackage("BB", fx.orderB1, "BOOKED");
  const pkgBAttempted = await makePackage("BA", fx.orderB1, "DELIVERY_ATTEMPTED");
  fx.trackingB = [pkgBBooked.trackingId, pkgBAttempted.trackingId].join(",");
  const shipmentB1 = await prisma.shipment.findFirst({ where: { orderId: fx.orderB1 } });
  const retB = await prisma.returnRequest.create({
    data: {
      returnNumber: `RET-S7V-B-${RUN}`,
      packageId: pkgBBooked.id,
      shipmentId: shipmentB1!.id,
      orderId: fx.orderB1,
      warehouseId: fx.warehouse,
      reason: "OTHER",
      status: "REQUESTED",
      requestedById: fx.adminUser,
    },
  });
  fx.returnB = retB.returnNumber;
  await prisma.supportTicket.create({
    data: {
      ticketNumber: `TKT-S7V-B-${RUN}`,
      category: "GENERAL",
      status: "OPEN",
      subject: `S7V ticket B ${RUN}`,
      description: "Vendor B ticket",
      raisedById: fx.vendorBOwner,
      vendorId: fx.vendorB,
    },
  });
  await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-S7V-B-${RUN}`,
      vendorId: fx.vendorB,
      subtotalPaisa: BigInt(70000),
      totalPaisa: BigInt(70000),
      status: "ISSUED",
      issuedById: fx.adminUser,
    },
  });
}, 120_000);

describe("Step 7 — vendor home model", () => {
  it("vendor block carries A's identity and its warehouse assignment", async () => {
    const model = await homeSvc.getVendorHome(vendorAActor);
    expect(model.vendor.id).toBe(fx.vendorA);
    expect(model.vendor.businessName).toBe(`S7V vendorA ${RUN}`);
    expect(model.vendor.verificationStatus).toBe("APPROVED");
    expect(model.vendor.isActive).toBe(true);
    expect(model.vendor.warehouses).toEqual([
      { warehouseId: fx.warehouse, warehouseCode: fx.warehouseCode, kind: "ORIGIN", isActive: true },
    ]);
  });

  it("metrics equal the planted truth for vendor A", async () => {
    const model = await homeSvc.getVendorHome(vendorAActor);
    expect(model.metrics.range.from).toBeTruthy();
    expect(model.metrics.range.to).toBeTruthy();
    expect(model.metrics.bookings).toBe(2);
    expect(model.metrics.delivered).toBe(1);
    expect(model.metrics.returnsCreated).toBe(1);
    expect(model.metrics.pendingPickup).toBe(1);
    expect(model.metrics.inTransit).toBe(1);
    expect(model.metrics.outForDelivery).toBe(0);
    expect(model.metrics.deliveryAttempted).toBe(1);
    // No ledger activity planted: the vendor-payable balance is 0,
    // and the open ISSUED invoice is the whole outstanding figure.
    expect(model.metrics.codPayablePaisa).toBe("0");
    expect(model.metrics.outstandingPaisa).toBe("50000");
  });

  it("attention counts are A's own attempted / returns / incidents / tickets", async () => {
    const model = await homeSvc.getVendorHome(vendorAActor);
    expect(model.attention).toEqual({
      deliveryAttempted: 1,
      returnsAwaiting: 1,
      openIncidents: 1,
      openTickets: 1,
    });
    expect(model.attentionShipments.map((s) => s.trackingId)).toEqual([fx.trackingAAttempted]);
  });

  it("recent lists contain exactly A's shipments, bookings and returns", async () => {
    const model = await homeSvc.getVendorHome(vendorAActor);
    expect(model.recentShipments.map((s) => s.trackingId).sort()).toEqual(
      fx.trackingA.split(",").sort(),
    );
    expect(model.recentBookings.map((b) => b.orderNumber).sort()).toEqual([
      `ORD-S7V-A1-${RUN}`,
      `ORD-S7V-A2-${RUN}`,
    ]);
    expect(model.recentReturns.map((r) => r.returnNumber)).toEqual([fx.returnA]);
  });

  it("vendor B's model has B's figures and none of A's identifiers", async () => {
    const modelB = await homeSvc.getVendorHome(vendorBActor);
    expect(modelB.vendor.id).toBe(fx.vendorB);
    expect(modelB.vendor.warehouses).toEqual([]);
    expect(modelB.metrics.bookings).toBe(1);
    expect(modelB.metrics.delivered).toBe(0);
    expect(modelB.metrics.pendingPickup).toBe(1);
    expect(modelB.metrics.outstandingPaisa).toBe("70000");
    expect(modelB.attention).toEqual({
      deliveryAttempted: 1,
      returnsAwaiting: 1,
      openIncidents: 0,
      openTickets: 1,
    });

    const serialisedB = JSON.stringify(modelB);
    for (const trackingId of fx.trackingA.split(",")) {
      expect(serialisedB).not.toContain(trackingId);
    }
    expect(serialisedB).not.toContain(fx.returnA);
    expect(serialisedB).not.toContain(`ORD-S7V-A1-${RUN}`);
    expect(serialisedB).not.toContain(fx.vendorA);

    const serialisedA = JSON.stringify(await homeSvc.getVendorHome(vendorAActor));
    for (const trackingId of fx.trackingB.split(",")) {
      expect(serialisedA).not.toContain(trackingId);
    }
    expect(serialisedA).not.toContain(fx.returnB);
    expect(serialisedA).not.toContain(fx.vendorB);
  });

  it("an unlinked actor is refused", async () => {
    const unlinked = { ...vendorAActor, vendorId: null };
    await expect(homeSvc.getVendorHome(unlinked as never)).rejects.toThrow(/vendor/);
  });
});
