import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hash } from "bcryptjs";
import type { PrismaClient } from "@prisma/client";

// `server-only` throws outside a React Server Component environment; the
// services under test are server-only code, so stub the marker module.
vi.mock("server-only", () => ({}));

// Point the app at bla_test BEFORE the service layer is imported (same
// pattern as warehouses.test.ts). Refuse to run anywhere else.
function readDevDatabaseUrl(): string {
  for (const file of [".env.local", "prisma/.env"]) {
    try {
      const text = readFileSync(path.resolve(process.cwd(), file), "utf8");
      const match = text.match(/^DATABASE_URL=(.+)$/m);
      if (match) return match[1].trim().replace(/^[\"']|[\"']$/g, "");
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
const RUN_NUM = String(Math.floor(Math.random() * 90000) + 10000); // 5 digits
const email = (label: string) => `p6gh-${label}-${RUN}@test.local`;
/** 13-digit phone, unique per (run, n). */
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);

let prisma: PrismaClient;
let invoicesSvc: typeof import("@/server/services/invoices");
let incidentsSvc: typeof import("@/server/services/incidents");
let reportsSvc: typeof import("@/server/services/reports");
let packagesSvc: typeof import("@/server/services/packages");
let customersSvc: typeof import("@/server/services/customers");
let actorLib: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");
let trackingLib: typeof import("@/lib/bookings/tracking");

const fx: Record<string, string> = {};

/** Build an ActorContext exactly the way getActorContext does — from
 *  the current DB state, including vendor/customer links. */
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
  const [vendorLink, customerProfile] = await Promise.all([
    prisma.vendorUser.findFirst({
      where: { userId: user.id, isActive: true, vendor: { isActive: true } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.customer.findUnique({ where: { userId: user.id } }),
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
    driverId: null,
    customerId: customerProfile?.id ?? null,
    landingPath: catalog.landingPathForRoles(roles as never[]),
  };
}

async function makeUser(label: string, roleCode: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: `P6GH ${label}`,
      passwordHash: await hash("fixture-password", 10),
      status: "ACTIVE",
    },
  });
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  if (!role) throw new Error(`role ${roleCode} not seeded in bla_test`);
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user.id;
}

async function makeOrder(input: {
  label: string;
  vendorId?: string;
  senderCustomerId?: string;
}): Promise<string> {
  const order = await prisma.order.create({
    data: {
      orderNumber: `P6GH-${RUN}-${input.label}`,
      vendorId: input.vendorId ?? null,
      customerId: input.senderCustomerId ?? null,
      createdById: fx.adminUser,
      createdByRole: "ADMIN",
      senderName: `Sender ${input.label}`,
      senderPhone: phone(7),
      destinationDistrict: "Kathmandu",
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-P6GH-${RUN}-${input.label}`,
      orderId: order.id,
      originWarehouseId: fx.warehouse,
      routeKind: "LAST_MILE",
      shippingServiceId: fx.service,
      shippingChargePaisa: BigInt(15000),
    },
  });
  return order.id;
}

async function makePackage(input: {
  orderId: string;
  recipientCustomerId?: string;
  operationalStatus?: string;
  deliveryStatus?: string;
}): Promise<string> {
  const shipment = await prisma.shipment.findFirst({ where: { orderId: input.orderId } });
  if (!shipment) throw new Error("fixture shipment missing");
  const pkg = await prisma.package.create({
    data: {
      trackingId: trackingLib.generateTrackingId(),
      shipmentId: shipment.id,
      orderId: input.orderId,
      recipientName: "Fixture Recipient",
      recipientPhone: phone(9),
      recipientCustomerId: input.recipientCustomerId ?? null,
      deliveryAddress: "Thamel",
      deliveryCity: "Kathmandu",
      deliveryDistrict: "Kathmandu",
      declaredWeightKg: "1.000",
      description: "Fixture parcel",
      operationalStatus: input.operationalStatus ?? "BOOKED",
      deliveryStatus: input.deliveryStatus ?? "NOT_STARTED",
    },
  });
  return pkg.id;
}

async function makeCustomerInvoice(customerId: string, label: string, total: number) {
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-P6GH-${RUN}-${label}`,
      customerId,
      subtotalPaisa: BigInt(total),
      totalPaisa: BigInt(total),
      status: "ISSUED",
      dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      issuedById: fx.adminUser,
      lines: {
        create: [
          {
            kind: "SHIPPING_CHARGE",
            description: `Fixture charge ${label}`,
            amountPaisa: BigInt(total),
          },
        ],
      },
    },
  });
  return invoice.id;
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/db/prisma"));
  invoicesSvc = await import("@/server/services/invoices");
  incidentsSvc = await import("@/server/services/incidents");
  reportsSvc = await import("@/server/services/reports");
  packagesSvc = await import("@/server/services/packages");
  customersSvc = await import("@/server/services/customers");
  actorLib = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");
  trackingLib = await import("@/lib/bookings/tracking");

  // Role/permission catalog must exist in bla_test (idempotent upserts,
  // same as prisma/seed.ts).
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

  fx.adminUser = await makeUser("admin", "ADMIN");

  // Shared warehouse + shipping service fixtures.
  const warehouse = await prisma.warehouse.upsert({
    where: { code: "WH-ZVS-61" },
    update: {},
    create: {
      code: "WH-ZVS-61",
      name: "P6GH Shared Warehouse",
      type: "REGIONAL",
      district: "Kathmandu",
      city: "Kathmandu",
      province: "Bagmati",
      status: "ACTIVE",
    },
  });
  fx.warehouse = warehouse.id;
  const service = await prisma.shippingService.create({
    data: { code: `P6S${RUN}`.slice(0, 20).toUpperCase(), name: "P6GH Standard" },
  });
  fx.service = service.id;

  // Driver (for the ProofOfDelivery fixture).
  const driverUser = await makeUser("driver", "RIDER");
  const driver = await prisma.driver.create({
    data: {
      userId: driverUser,
      homeWarehouseId: fx.warehouse,
      licenseNumber: `LIC-P6GH-${RUN}`,
      licenseExpiry: new Date("2030-01-01"),
    },
  });
  fx.driver = driver.id;

  // Two vendor organisations with an owner user each.
  for (const label of ["vendorA", "vendorB"] as const) {
    const vendor = await prisma.vendor.create({
      data: {
        businessName: `P6GH ${label} ${RUN}`,
        contactName: `${label} Contact`,
        email: email(label),
        phone: phone(label === "vendorA" ? 21 : 22),
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

  // Two customers, each linked to a CUSTOMER user.
  for (const label of ["custA", "custB"] as const) {
    const userId = await makeUser(label, "CUSTOMER");
    fx[`${label}User`] = userId;
    const customer = await prisma.customer.create({
      data: {
        fullName: `P6GH ${label}`,
        phone: phone(label === "custA" ? 31 : 32),
        normalizedPhone: phone(label === "custA" ? 31 : 32),
        email: email(label),
        userId,
      },
    });
    fx[label] = customer.id;
  }

  // Vendor A: 3 bookings; packages in known states.
  fx.orderA1 = await makeOrder({ label: "A1", vendorId: fx.vendorA });
  fx.orderA2 = await makeOrder({ label: "A2", vendorId: fx.vendorA });
  fx.orderA3 = await makeOrder({ label: "A3", vendorId: fx.vendorA });
  fx.pkgA1Transit = await makePackage({ orderId: fx.orderA1, operationalStatus: "IN_TRANSIT" });
  fx.pkgA1Booked = await makePackage({ orderId: fx.orderA1, operationalStatus: "BOOKED" });
  fx.pkgA2Delivered = await makePackage({
    orderId: fx.orderA2,
    operationalStatus: "DELIVERED",
    deliveryStatus: "DELIVERED",
  });
  fx.pkgA3Booked = await makePackage({ orderId: fx.orderA3, operationalStatus: "BOOKED" });

  // Delivered proof for A2's package (report "delivered" counts these).
  const assignment = await prisma.deliveryAssignment.create({
    data: { packageId: fx.pkgA2Delivered, driverId: fx.driver, assignedById: fx.adminUser, status: "COMPLETED" },
  });
  await prisma.proofOfDelivery.create({
    data: {
      packageId: fx.pkgA2Delivered,
      assignmentId: assignment.id,
      deliveredAt: new Date(),
      recordedById: fx.adminUser,
    },
  });

  // One open return against vendor A's delivered package.
  const shipmentA2 = await prisma.shipment.findFirst({ where: { orderId: fx.orderA2 } });
  await prisma.returnRequest.create({
    data: {
      returnNumber: `RET-P6GH-${RUN}-1`,
      packageId: fx.pkgA2Delivered,
      shipmentId: shipmentA2!.id,
      orderId: fx.orderA2,
      warehouseId: fx.warehouse,
      reason: "OTHER",
      status: "REQUESTED",
      requestedById: fx.adminUser,
    },
  });

  // Vendor invoices: A owes 50_000 outstanding; B owes 70_000.
  await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-P6GH-${RUN}-VA`,
      vendorId: fx.vendorA,
      subtotalPaisa: BigInt(50000),
      totalPaisa: BigInt(50000),
      status: "ISSUED",
      issuedById: fx.adminUser,
    },
  });
  fx.orderB1 = await makeOrder({ label: "B1", vendorId: fx.vendorB });
  await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-P6GH-${RUN}-VB`,
      vendorId: fx.vendorB,
      subtotalPaisa: BigInt(70000),
      totalPaisa: BigInt(70000),
      status: "ISSUED",
      issuedById: fx.adminUser,
    },
  });

  // Customer invoices: one per customer.
  fx.invoiceCustA = await makeCustomerInvoice(fx.custA, "CA", 10000);
  fx.invoiceCustB = await makeCustomerInvoice(fx.custB, "CB", 20000);

  // Orders the customers SENT (Order.customerId = sender customer) and
  // packages addressed TO them (Package.recipientCustomerId).
  fx.orderSenderA = await makeOrder({ label: "SA", senderCustomerId: fx.custA });
  fx.orderSenderB = await makeOrder({ label: "SB", senderCustomerId: fx.custB });
  fx.pkgToA = await makePackage({ orderId: fx.orderA1, recipientCustomerId: fx.custA });
  fx.pkgToB = await makePackage({ orderId: fx.orderB1, recipientCustomerId: fx.custB });
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("customer invoice scoping (Phase 6, audit M-3)", () => {
  it("lists only the customer's own invoices; the other customer's invoice is invisible", async () => {
    const a = await actorFor(fx.custAUser);
    const listA = await invoicesSvc.listInvoices(a, { pageSize: 50 });
    const idsA = listA.items.map((i) => i.id);
    expect(idsA).toContain(fx.invoiceCustA);
    expect(idsA).not.toContain(fx.invoiceCustB);
    // Vendor invoices must not leak into a customer list either.
    expect(listA.items.every((i) => i.customerId === fx.custA)).toBe(true);

    const b = await actorFor(fx.custBUser);
    const listB = await invoicesSvc.listInvoices(b, { pageSize: 50 });
    expect(listB.items.map((i) => i.id)).toEqual([fx.invoiceCustB]);
  }, 30_000);

  it("getInvoice composes for the owner (lines + totals) and denies the other customer, audited", async () => {
    const a = await actorFor(fx.custAUser);
    const detail = await invoicesSvc.getInvoice(a, fx.invoiceCustA);
    expect(detail.totalPaisa).toBe("10000");
    expect(detail.outstandingPaisa).toBe("10000");
    expect(detail.lines).toHaveLength(1);
    expect(detail.payments).toEqual([]);

    await expect(invoicesSvc.getInvoice(a, fx.invoiceCustB)).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
    const audit = await prisma.auditLog.findFirst({
      where: {
        actorId: fx.custAUser,
        action: "access.denied",
        entityType: "Invoice",
        entityId: fx.invoiceCustB,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect((audit?.after as { reason?: string } | null)?.reason).toBe(
      "customer_scope_other_customer_invoice",
    );
  }, 30_000);

  it("getOwnCustomerProfile returns only the actor's linked record", async () => {
    const a = await actorFor(fx.custAUser);
    const profile = await customersSvc.getOwnCustomerProfile(a);
    expect(profile.id).toBe(fx.custA);

    const vendor = await actorFor(fx.vendorAOwner);
    await expect(customersSvc.getOwnCustomerProfile(vendor)).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
  }, 30_000);
});

describe("customer incidents + payment disputes (Phase 6, audit M-3)", () => {
  it("files a PAYMENT_DISPUTE on the customer's own order and sees it in their incident list", async () => {
    const a = await actorFor(fx.custAUser);
    const view = await incidentsSvc.createIncident(a, {
      category: "PAYMENT_DISPUTE",
      description: "Charged twice for the same delivery — please check the payment.",
      orderId: fx.orderSenderA,
    });
    expect(view.category).toBe("PAYMENT_DISPUTE");
    expect(view.orderId).toBe(fx.orderSenderA);

    const list = await incidentsSvc.listIncidents(a, { page: 1, pageSize: 50 });
    expect(list.items.map((i) => i.id)).toContain(view.id);

    // The other customer never sees it.
    const b = await actorFor(fx.custBUser);
    const listB = await incidentsSvc.listIncidents(b, { page: 1, pageSize: 50 });
    expect(listB.items.map((i) => i.id)).not.toContain(view.id);
  }, 30_000);

  it("refuses a PAYMENT_DISPUTE on another customer's order, audited", async () => {
    const a = await actorFor(fx.custAUser);
    await expect(
      incidentsSvc.createIncident(a, {
        category: "PAYMENT_DISPUTE",
        description: "This dispute is about someone else's order.",
        orderId: fx.orderSenderB,
      }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);

    const audit = await prisma.auditLog.findFirst({
      where: { actorId: fx.custAUser, action: "access.denied", entityType: "Incident" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect((audit?.after as { reason?: string } | null)?.reason).toBe("order_not_own_customer");
  }, 30_000);

  it("reports an incident on the customer's own package; another customer's package is refused, audited", async () => {
    const a = await actorFor(fx.custAUser);
    const view = await incidentsSvc.createIncident(a, {
      category: "DAMAGED_PACKAGE",
      description: "The parcel arrived with a crushed corner.",
      packageId: fx.pkgToA,
    });
    expect(view.packageId).toBe(fx.pkgToA);
    const list = await incidentsSvc.listIncidents(a, { page: 1, pageSize: 50 });
    expect(list.items.map((i) => i.id)).toContain(view.id);

    await expect(
      incidentsSvc.createIncident(a, {
        category: "DAMAGED_PACKAGE",
        description: "Reporting damage on a package that is not mine.",
        packageId: fx.pkgToB,
      }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
    const audit = await prisma.auditLog.findFirst({
      where: { actorId: fx.custAUser, action: "access.denied", entityType: "Incident" },
      orderBy: { createdAt: "desc" },
    });
    expect((audit?.after as { reason?: string } | null)?.reason).toBe("package_not_own_customer");
  }, 30_000);
});

describe("vendor home figures (Phase 6)", () => {
  it("vendor report figures match the seeded fixtures for org A only", async () => {
    const a = await actorFor(fx.vendorAOwner);
    const report = await reportsSvc.getVendorReport(a, {});
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row.vendorId).toBe(fx.vendorA);
    expect(row.bookings).toBe(3);
    expect(row.delivered).toBe(1);
    expect(row.returnsCreated).toBe(1);
    expect(row.invoicesIssued).toBe(1);
    expect(row.chargesInvoicedPaisa).toBe("50000");
    expect(row.outstandingPaisa).toBe("50000");
    expect(row.payableBalancePaisa).toBe("0");
    expect(row.codExpectedPaisa).toBe("0");
  }, 30_000);

  it("vendor B sees none of org A's figures", async () => {
    const b = await actorFor(fx.vendorBOwner);
    const report = await reportsSvc.getVendorReport(b, {});
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row.vendorId).toBe(fx.vendorB);
    expect(row.bookings).toBe(1);
    expect(row.delivered).toBe(0);
    expect(row.returnsCreated).toBe(0);
    expect(row.outstandingPaisa).toBe("70000");
  }, 30_000);

  it("package status buckets behind the vendor home metrics are org-scoped", async () => {
    const a = await actorFor(fx.vendorAOwner);
    const bookedA = await packagesSvc.listPackages(a, { status: "BOOKED", page: 1, pageSize: 1 });
    const transitA = await packagesSvc.listPackages(a, { status: "IN_TRANSIT", page: 1, pageSize: 1 });
    // A's BOOKED packages: pkgA1Booked + pkgA3Booked (+ pkgToA is BOOKED too).
    expect(bookedA.meta.total).toBe(3);
    expect(transitA.meta.total).toBe(1);

    const b = await actorFor(fx.vendorBOwner);
    const bookedB = await packagesSvc.listPackages(b, { status: "BOOKED", page: 1, pageSize: 1 });
    const transitB = await packagesSvc.listPackages(b, { status: "IN_TRANSIT", page: 1, pageSize: 1 });
    // B's only package is pkgToB (BOOKED, on B's order B1).
    expect(bookedB.meta.total).toBe(1);
    expect(transitB.meta.total).toBe(0);
  }, 30_000);
});
