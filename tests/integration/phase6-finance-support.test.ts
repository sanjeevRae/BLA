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
const email = (label: string) => `p6ij-${label}-${RUN}@test.local`;
const DAY_MS = 24 * 60 * 60 * 1000;

let prisma: PrismaClient;
let financeHomeSvc: typeof import("@/server/services/finance-home");
let supportHomeSvc: typeof import("@/server/services/support-home");
let tasksSvc: typeof import("@/server/services/tasks");
let invoicesSvc: typeof import("@/server/services/invoices");
let actorLib: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

let financeAId: string;
let financeBId: string;
let supportId: string;
let warehouseId: string;

let plantedInvoiceId: string;
let plantedPaymentId: string;
let plantedAdjustmentId: string;
let plantedRefundId: string;
let plantedRemittanceNumber: string;
let plantedSettlementId: string;

/** Build an ActorContext exactly the way getActorContext does — from the
 *  current DB state — so role grants take effect immediately. */
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
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: `P6IJ ${label}`,
      passwordHash: await hash("fixture-password", 10),
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    },
  });
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  if (!role) throw new Error(`role ${roleCode} not seeded in bla_test`);
  await prisma.userRole.create({
    data: { userId: user.id, roleId: role.id, assignedById: user.id },
  });
  return user.id;
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/db/prisma"));
  financeHomeSvc = await import("@/server/services/finance-home");
  supportHomeSvc = await import("@/server/services/support-home");
  tasksSvc = await import("@/server/services/tasks");
  invoicesSvc = await import("@/server/services/invoices");
  actorLib = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");

  // Role/permission catalog must exist in bla_test (idempotent upserts,
  // same as prisma/seed.ts and warehouses.test.ts).
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

  financeAId = await makeUser("finance-a", "FINANCE");
  financeBId = await makeUser("finance-b", "FINANCE");
  supportId = await makeUser("support", "SUPPORT");

  // Shared warehouse (find-or-create) for the driver/remittance and
  // overdue-delivery fixtures.
  const warehouse =
    (await prisma.warehouse.findUnique({ where: { code: "WH-P6I-61" } })) ??
    (await prisma.warehouse.create({
      data: {
        code: "WH-P6I-61",
        name: "P6IJ Warehouse",
        type: "REGIONAL",
        district: "Kathmandu",
        city: "Kathmandu",
        province: "Bagmati",
        status: "ACTIVE",
      },
    }));
  warehouseId = warehouse.id;

  // Remove THIS suite's leftovers from earlier runs. The finance /
  // support home queues are capped stalest-first lists; the tests
  // backdate their planted rows to 2000-01-01 so they head those
  // queues, but without this cleanup each run's own backdated rows
  // tie with the next run's and crowd the cap. Only the suite's own
  // P6IJ-prefixed fixtures are touched.
  await prisma.codRemittance.deleteMany({
    where: { remittanceNumber: { startsWith: "REM-P6IJ-" } },
  });
  await prisma.financialAdjustment.deleteMany({
    where: { reason: { startsWith: "P6IJ" } },
  });
  await prisma.refund.deleteMany({ where: { reason: { startsWith: "P6IJ" } } });
  await prisma.package.deleteMany({
    where: { trackingId: { startsWith: "BLA-P6IJ-" } },
  });
  await prisma.shipment.deleteMany({
    where: { shipmentNumber: { startsWith: "SHP-P6IJ-" } },
  });
  await prisma.order.deleteMany({
    where: { orderNumber: { startsWith: "ORD-P6IJ-" } },
  });
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Phase 6 finance home read", () => {
  it("reports planted invoices, payments, remittances, settlements and four-eyes attention accurately (deltas over the shared test DB)", async () => {
    const financeA = await actorFor(financeAId);
    const before = await financeHomeSvc.getFinanceHome(financeA);

    // --- Plant known-state finance records (direct rows; the home
    // read derives every figure from these records). ---
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-P6IJ-${RUN}`,
        subtotalPaisa: BigInt(100_00),
        totalPaisa: BigInt(100_00),
        status: "ISSUED",
        issuedById: financeAId,
        issuedAt: new Date(),
      },
    });
    plantedInvoiceId = invoice.id;

    const payment = await prisma.payment.create({
      data: {
        payerType: "COMPANY",
        amountPaisa: BigInt(40_00),
        method: "CASH",
        status: "PAID",
        recordedById: financeAId,
        paidAt: new Date(),
      },
    });
    plantedPaymentId = payment.id;
    // Allocate part of the payment so outstanding is total − paid.
    await prisma.paymentAllocation.create({
      data: {
        paymentId: payment.id,
        invoiceId: invoice.id,
        amountPaisa: BigInt(40_00),
        allocatedById: financeAId,
      },
    });

    // Rider + remittance awaiting verification.
    const riderUserId = await makeUser("rider", "RIDER");
    const driver = await prisma.driver.create({
      data: {
        userId: riderUserId,
        homeWarehouseId: warehouseId,
        licenseNumber: `LIC-P6IJ-${RUN}`,
        licenseExpiry: new Date(Date.now() + 365 * DAY_MS),
      },
    });
    plantedRemittanceNumber = `REM-P6IJ-${RUN}`;
    const plantedRemittance = await prisma.codRemittance.create({
      data: {
        remittanceNumber: plantedRemittanceNumber,
        driverId: driver.id,
        submittedById: riderUserId,
        declaredAmountPaisa: BigInt(55_00),
        status: "SUBMITTED",
        submittedAt: new Date(),
      },
    });
    // The finance-home attention queues are stalest-first (asc,
    // capped). Backdate the planted queue rows so they sit at the
    // head of their queue no matter how many older rows the shared
    // test DB has accumulated from other suites / earlier runs —
    // otherwise the presence assertions below depend on DB history.
    const queueOldest = new Date("2000-01-01T00:00:00Z");
    await prisma.codRemittance.update({
      where: { id: plantedRemittance.id },
      data: { submittedAt: queueOldest },
    });
    await prisma.codRemittance.create({
      data: {
        remittanceNumber: `REM-P6IJ-D-${RUN}`,
        driverId: driver.id,
        submittedById: riderUserId,
        declaredAmountPaisa: BigInt(20_00),
        countedAmountPaisa: BigInt(18_00),
        discrepancyPaisa: BigInt(-2_00),
        status: "DISCREPANCY",
        submittedAt: new Date(),
      },
    });

    // Vendor + pending settlement (awaiting ADMIN approval, read-only
    // for Finance).
    const vendor = await prisma.vendor.create({
      data: {
        businessName: `P6IJ Vendor ${RUN}`,
        contactName: "P6IJ Contact",
        phone: "9800000000",
        verificationStatus: "APPROVED",
        createdById: financeAId,
      },
    });
    const settlement = await prisma.vendorSettlement.create({
      data: {
        settlementNumber: `STL-P6IJ-${RUN}`,
        vendorId: vendor.id,
        periodStart: new Date(Date.now() - 7 * DAY_MS),
        periodEnd: new Date(),
        grossCodPaisa: BigInt(90_00),
        shippingChargesPaisa: BigInt(10_00),
        netPayablePaisa: BigInt(80_00),
        status: "PENDING",
        preparedById: financeAId,
      },
    });
    plantedSettlementId = settlement.id;

    // Adjustment created BY finance A + refund requested BY finance A.
    const adjustment = await prisma.financialAdjustment.create({
      data: {
        targetType: "INVOICE",
        targetId: invoice.id,
        amountPaisa: BigInt(5_00),
        reason: "P6IJ credit note fixture",
        status: "REQUESTED",
        createdById: financeAId,
      },
    });
    plantedAdjustmentId = adjustment.id;
    await prisma.financialAdjustment.update({
      where: { id: adjustment.id },
      data: { createdAt: queueOldest },
    });
    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amountPaisa: BigInt(3_00),
        reason: "P6IJ refund fixture",
        status: "REQUESTED",
        requestedById: financeAId,
      },
    });
    plantedRefundId = refund.id;
    await prisma.refund.update({
      where: { id: refund.id },
      data: { createdAt: queueOldest },
    });

    const after = await financeHomeSvc.getFinanceHome(financeA);

    // Counts move by exactly the planted amounts.
    expect(after.attention.remittancesAwaitingVerification.count).toBe(
      before.attention.remittancesAwaitingVerification.count + 1,
    );
    expect(after.attention.remittancesInDiscrepancy.count).toBe(
      before.attention.remittancesInDiscrepancy.count + 1,
    );
    expect(after.attention.adjustmentsRequested.count).toBe(
      before.attention.adjustmentsRequested.count + 1,
    );
    expect(after.attention.refundsRequested.count).toBe(before.attention.refundsRequested.count + 1);
    expect(after.attention.settlementsAwaitingAdminApproval.count).toBe(
      before.attention.settlementsAwaitingAdminApproval.count + 1,
    );
    expect(
      BigInt(after.attention.settlementsAwaitingAdminApproval.netPayablePaisa) -
        BigInt(before.attention.settlementsAwaitingAdminApproval.netPayablePaisa),
    ).toBe(BigInt(80_00));

    // The planted remittance is listed for verification.
    expect(
      after.attention.remittancesAwaitingVerification.items.map((i) => i.remittanceNumber),
    ).toContain(plantedRemittanceNumber);

    // Today's operations: at least one more invoice issued (100_00)
    // and one more PAID payment (40_00) than before planting. These
    // two are "at least" rather than exact deltas: bla_test is shared
    // and sibling Phase 6 suites running in parallel plant same-day
    // invoices/payments (observed: +2 payments during one run). The
    // exact, identity-level checks are the planted payment's presence
    // in recentPayments (below) and the outstanding/vendor-payable
    // deltas, which are driven by records only this test creates in
    // these states.
    expect(after.operationsToday.invoicesIssued.count).toBeGreaterThanOrEqual(
      before.operationsToday.invoicesIssued.count + 1,
    );
    expect(
      BigInt(after.operationsToday.invoicesIssued.totalPaisa) -
        BigInt(before.operationsToday.invoicesIssued.totalPaisa),
    ).toBeGreaterThanOrEqual(BigInt(100_00));
    expect(after.operationsToday.paymentsReceived.count).toBeGreaterThanOrEqual(
      before.operationsToday.paymentsReceived.count + 1,
    );
    expect(
      BigInt(after.operationsToday.paymentsReceived.totalPaisa) -
        BigInt(before.operationsToday.paymentsReceived.totalPaisa),
    ).toBeGreaterThanOrEqual(BigInt(40_00));

    // Metrics: outstanding grows by total − allocated = 60_00;
    // vendor payable grows by the pending settlement's net.
    expect(
      BigInt(after.metrics.outstandingReceivablesPaisa) -
        BigInt(before.metrics.outstandingReceivablesPaisa),
    ).toBe(BigInt(60_00));
    expect(after.metrics.openInvoicesCount).toBe(before.metrics.openInvoicesCount + 1);
    expect(
      BigInt(after.metrics.vendorPayablePaisa) - BigInt(before.metrics.vendorPayablePaisa),
    ).toBe(BigInt(80_00));

    // Recent payments include the planted payment.
    expect(after.recentPayments.map((p) => p.id)).toContain(plantedPaymentId);
  }, 60_000);

  it("four-eyes honesty: the creator sees AWAITING_ANOTHER_APPROVER; another finance user sees it as actionable", async () => {
    const financeA = await actorFor(financeAId);
    const financeB = await actorFor(financeBId);
    // FINANCE holds finance.approve_adjustment / refund.process in the
    // current catalog (Phase 2), so a non-creator is a real approver.
    expect(financeB.permissions.has("finance.approve_adjustment")).toBe(true);

    const homeA = await financeHomeSvc.getFinanceHome(financeA);
    const ownAdjustment = homeA.attention.adjustmentsRequested.items.find(
      (i) => i.id === plantedAdjustmentId,
    );
    expect(ownAdjustment).toBeDefined();
    expect(ownAdjustment!.isOwn).toBe(true);
    expect(ownAdjustment!.createdById).toBe(financeAId);
    expect(ownAdjustment!.awaiting).toBe("AWAITING_ANOTHER_APPROVER");
    const ownRefund = homeA.attention.refundsRequested.items.find((i) => i.id === plantedRefundId);
    expect(ownRefund).toBeDefined();
    expect(ownRefund!.isOwn).toBe(true);
    expect(ownRefund!.awaiting).toBe("AWAITING_ANOTHER_APPROVER");

    const homeB = await financeHomeSvc.getFinanceHome(financeB);
    const otherAdjustment = homeB.attention.adjustmentsRequested.items.find(
      (i) => i.id === plantedAdjustmentId,
    );
    expect(otherAdjustment).toBeDefined();
    expect(otherAdjustment!.isOwn).toBe(false);
    expect(otherAdjustment!.awaiting).toBe("ACTIONABLE_BY_ACTOR");
    const otherRefund = homeB.attention.refundsRequested.items.find((i) => i.id === plantedRefundId);
    expect(otherRefund).toBeDefined();
    expect(otherRefund!.isOwn).toBe(false);
    expect(otherRefund!.awaiting).toBe("ACTIONABLE_BY_ACTOR");

    // Settlement approval is NOT surfaced to Finance: the actor does
    // not hold settlement.approve, and the home only reports the
    // pending queue read-only.
    expect(financeA.permissions.has("settlement.approve")).toBe(false);
    expect(homeA.attention.settlementsAwaitingAdminApproval.count).toBeGreaterThanOrEqual(1);
    void plantedSettlementId;
    void plantedInvoiceId;
  }, 60_000);
});

describe("Phase 6 support home read", () => {
  it("queue counts match planted tickets in each state, plus incident and overdue-delivery counts (deltas)", async () => {
    const support = await actorFor(supportId);
    const before = await supportHomeSvc.getSupportHome(support);

    const plantTicket = async (
      suffix: string,
      status: string,
      extra: Record<string, unknown> = {},
    ) => {
      return prisma.supportTicket.create({
        data: {
          ticketNumber: `TKT-P6IJ-${RUN}-${suffix}`,
          category: "GENERAL",
          status,
          priority: "NORMAL",
          subject: `P6IJ fixture ${suffix}`,
          description: "Phase 6 support home fixture ticket.",
          ...extra,
        },
      });
    };

    await plantTicket("open", "OPEN");
    await plantTicket("open-old", "OPEN", { createdAt: new Date(Date.now() - 72 * 60 * 60 * 1000) });
    await plantTicket("prog", "IN_PROGRESS", { assignedToId: supportId });
    await plantTicket("wait", "AWAITING_CUSTOMER", { assignedToId: supportId });
    await plantTicket("esc", "ESCALATED", { assignedToId: supportId });
    await plantTicket("done", "RESOLVED", {
      assignedToId: supportId,
      resolvedAt: new Date(),
      resolutionNote: "P6IJ resolved fixture",
    });

    // High-severity, customer-facing (support-scope) open incident.
    await prisma.incident.create({
      data: {
        incidentNumber: `INC-P6IJ-${RUN}`,
        category: "CUSTOMER_COMPLAINT",
        severity: "HIGH",
        status: "REPORTED",
        description: "P6IJ support home fixture incident.",
        reporterId: supportId,
        responsibleTeam: "SUPPORT",
      },
    });

    // Overdue delivery: shipment expected yesterday, package not
    // delivered; plus a delivered control package that must NOT count.
    const service =
      (await prisma.shippingService.findUnique({ where: { code: `SVC-P6IJ-${RUN}` } })) ??
      (await prisma.shippingService.create({
        data: { code: `SVC-P6IJ-${RUN}`, name: "P6IJ Service" },
      }));
    const order = await prisma.order.create({
      data: {
        orderNumber: `ORD-P6IJ-${RUN}`,
        createdById: supportId,
        createdByRole: "SUPPORT",
        senderName: "P6IJ Sender",
        senderPhone: "9800000001",
        destinationDistrict: "Kathmandu",
        paymentMethod: "CASH",
        pickupMethod: "WAREHOUSE_DROPOFF",
        status: "CONFIRMED",
      },
    });
    const mkShipmentAndPackage = async (
      suffix: string,
      expectedDeliveryAt: Date,
      deliveryStatus: string,
      operationalStatus: string,
    ) => {
      const shipment = await prisma.shipment.create({
        data: {
          shipmentNumber: `SHP-P6IJ-${RUN}-${suffix}`,
          orderId: order.id,
          originWarehouseId: warehouseId,
          routeKind: "LAST_MILE",
          shippingServiceId: service.id,
          shippingChargePaisa: BigInt(10_00),
          expectedDeliveryAt,
          status: "ACTIVE",
        },
      });
      return prisma.package.create({
        data: {
          trackingId: `BLA-P6IJ-${RUN}-${suffix}`,
          shipmentId: shipment.id,
          orderId: order.id,
          recipientName: "P6IJ Recipient",
          recipientPhone: "9800000002",
          deliveryAddress: "Kapan, Kathmandu",
          deliveryCity: "Kathmandu",
          deliveryDistrict: "Kathmandu",
          declaredWeightKg: "1.000",
          description: "P6IJ fixture parcel",
          deliveryStatus,
          operationalStatus,
        },
      });
    };
    // The overdue list is most-overdue-first (expectedDeliveryAt
    // asc, capped) — plant this one as ancient so it always heads
    // the list regardless of rows accumulated by other suites/runs.
    const overduePkg = await mkShipmentAndPackage(
      "OD",
      new Date("2000-01-01T00:00:00Z"),
      "OUT_FOR_DELIVERY",
      "OUT_FOR_DELIVERY",
    );
    await mkShipmentAndPackage("DL", new Date(Date.now() - DAY_MS), "DELIVERED", "DELIVERED");

    const after = await supportHomeSvc.getSupportHome(support);

    expect(after.queues.open).toBe(before.queues.open + 2);
    expect(after.queues.inProgress).toBe(before.queues.inProgress + 1);
    expect(after.queues.awaitingCustomer).toBe(before.queues.awaitingCustomer + 1);
    expect(after.queues.escalated).toBe(before.queues.escalated + 1);
    expect(after.queues.resolvedToday).toBe(before.queues.resolvedToday + 1);
    expect(after.queues.totalOpen).toBe(before.queues.totalOpen + 5);
    expect(after.metrics.openTickets).toBe(after.queues.totalOpen);

    // Two planted OPEN tickets are unassigned; the 72h-old one also
    // breaches the 48h attention threshold.
    expect(after.attention.unassignedTickets).toBe(before.attention.unassignedTickets + 2);
    expect(after.attention.breachingTickets).toBe(before.attention.breachingTickets + 1);

    expect(after.metrics.openIncidents).toBe(before.metrics.openIncidents + 1);
    expect(after.attention.unresolvedHighSeverityIncidents).toBe(
      before.attention.unresolvedHighSeverityIncidents + 1,
    );

    // Exactly one of the two planted packages is overdue.
    expect(after.metrics.overdueDeliveries).toBe(before.metrics.overdueDeliveries + 1);
    expect(after.attention.overdueDeliveries).toBe(after.metrics.overdueDeliveries);
    expect(after.overdueDeliveryItems.map((i) => i.packageId)).toContain(overduePkg.id);
  }, 60_000);

  it("support actor is denied a payment mutation (no custody/payment path)", async () => {
    const support = await actorFor(supportId);
    expect(support.permissions.has("finance.record_payment")).toBe(false);
    expect(support.permissions.has("custody.handover")).toBe(false);
    await expect(
      invoicesSvc.recordPayment(support, {
        amountPaisa: "100",
        method: "CASH",
        allocations: [],
      }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
  }, 60_000);
});

describe("Phase 6 task visibility for FINANCE / SUPPORT (M-2)", () => {
  it("a finance-created task is visible to its support assignee, and vice versa", async () => {
    const financeA = await actorFor(financeAId);
    const support = await actorFor(supportId);

    const task = await tasksSvc.createTask(financeA, {
      title: `P6IJ finance→support task ${RUN}`,
      description: "Investigate the planted COD discrepancy.",
      assigneeId: supportId,
      priority: "NORMAL",
      publish: true,
    });
    expect(task.createdById).toBe(financeAId);
    expect(task.assigneeId).toBe(supportId);

    const supportBoard = await tasksSvc.listTasks(support, { queue: "mine", pageSize: 50 });
    expect(supportBoard.items.map((t) => t.id)).toContain(task.id);
    const supportView = await tasksSvc.getTask(support, task.id);
    expect(supportView.id).toBe(task.id);

    const reverse = await tasksSvc.createTask(support, {
      title: `P6IJ support→finance task ${RUN}`,
      assigneeId: financeAId,
      priority: "NORMAL",
      publish: true,
    });
    const financeBoard = await tasksSvc.listTasks(financeA, { queue: "mine", pageSize: 50 });
    expect(financeBoard.items.map((t) => t.id)).toContain(reverse.id);
    const financeCreated = await tasksSvc.listTasks(financeA, { queue: "created", pageSize: 50 });
    expect(financeCreated.items.map((t) => t.id)).toContain(task.id);
  }, 60_000);
});
