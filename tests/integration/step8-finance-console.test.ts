import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Step 8 (V3) — Finance console read model against bla_test.
 *
 * bla_test is SHARED, so global figures are asserted as
 * before/after DELTAS against the planted truth (the Phase 6
 * finance-home pattern), plus exact composition equalities that
 * cannot drift: console.period === getFinanceReport output,
 * console outstanding === getFinanceOverview openInvoices, console
 * COD === an independent all-collections DB accumulation written
 * in this test, and COD deltas === getCodReport totals deltas over
 * a range covering the fixtures (the single-definition proof for
 * the mirrored all-time accumulation — getCodReport itself caps
 * ranges at 366 days, so it cannot be called all-time).
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
const email = (label: string) => `s8f-${label}-${RUN}@bla.test`;
const QUEUE_OLDEST = new Date("2000-01-01T00:00:00Z");

let prisma: import("@prisma/client").PrismaClient;
let financeHomeSvc: typeof import("@/server/services/finance-home");
let reportsFinanceSvc: typeof import("@/server/services/reports-finance");
let financeOverviewSvc: typeof import("@/server/services/finance-overview");
let settlementsSvc: typeof import("@/server/services/settlements");
let codRemittancesSvc: typeof import("@/server/services/cod-remittances");
let domain: typeof import("@/lib/reports/domain");
let catalog: typeof import("@/lib/permissions/catalog");

type Actor = Awaited<ReturnType<typeof actorFor>>;

const fx: Record<string, string> = {};
let financeActor: Actor;
let supportActor: Actor;

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
      fullName: `S8F ${label}`,
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

/** One delivered package + assignment + COD collection. */
async function makeCollection(label: string, collectedPaisa: bigint): Promise<string> {
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-S8F-${label}-${RUN}`,
      vendorId: fx.vendor,
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
      shipmentNumber: `SHP-S8F-${label}-${RUN}`,
      orderId: order.id,
      originWarehouseId: fx.warehouse,
      routeKind: "LAST_MILE",
      shippingServiceId: fx.service,
      shippingChargePaisa: BigInt(15000),
    },
  });
  const pkg = await prisma.package.create({
    data: {
      trackingId: `BLA-S8F-${label}-${RUN}`,
      shipmentId: shipment.id,
      orderId: order.id,
      recipientName: `Recipient ${label}`,
      recipientPhone: "9779800000300",
      deliveryAddress: `Address ${label}`,
      deliveryCity: "Kathmandu",
      deliveryDistrict: "Kathmandu",
      declaredWeightKg: "1.000",
      description: `Parcel ${label}`,
      codAmountPaisa: collectedPaisa,
      operationalStatus: "DELIVERED",
      deliveryStatus: "DELIVERED",
    },
  });
  const assignment = await prisma.deliveryAssignment.create({
    data: { packageId: pkg.id, driverId: fx.driver, assignedById: fx.adminUser, status: "COMPLETED" },
  });
  const collection = await prisma.deliveryCodCollection.create({
    data: {
      packageId: pkg.id,
      shipmentId: shipment.id,
      assignmentId: assignment.id,
      expectedPaisa: collectedPaisa,
      collectedPaisa,
      status: "MATCHED",
      collectedById: fx.riderUser,
      collectedAt: new Date(),
    },
  });
  return collection.id;
}

async function makeRemittance(
  label: string,
  status: string,
  declaredPaisa: bigint,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const remittance = await prisma.codRemittance.create({
    data: {
      remittanceNumber: `RMT-S8F-${label}-${RUN}`,
      driverId: fx.driver,
      submittedById: fx.riderUser,
      declaredAmountPaisa: declaredPaisa,
      status,
      submittedAt: new Date(),
      ...extra,
    },
  });
  fx[`remittance-${label}`] = remittance.id;
  return remittance.id;
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
  financeHomeSvc = await import("@/server/services/finance-home");
  reportsFinanceSvc = await import("@/server/services/reports-finance");
  financeOverviewSvc = await import("@/server/services/finance-overview");
  settlementsSvc = await import("@/server/services/settlements");
  codRemittancesSvc = await import("@/server/services/cod-remittances");
  domain = await import("@/lib/reports/domain");
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
      code: `S8F-${RUN}`,
      name: `S8F Warehouse ${RUN}`,
      district: "Kathmandu",
      city: "Kathmandu",
      province: "Bagmati",
      status: "ACTIVE",
    },
  });
  fx.warehouse = warehouse.id;
  const service = await prisma.shippingService.create({
    data: { code: `S8FSVC-${RUN}`, name: `S8F Service ${RUN}` },
  });
  fx.service = service.id;

  fx.adminUser = await makeUser("admin", "ADMIN");
  fx.financeUser = await makeUser("finance", "FINANCE");
  fx.financeOther = await makeUser("finance-other", "FINANCE");
  fx.supportUser = await makeUser("support", "SUPPORT");
  fx.riderUser = await makeUser("rider", "RIDER");
  const driver = await prisma.driver.create({
    data: {
      userId: fx.riderUser,
      homeWarehouseId: fx.warehouse,
      licenseNumber: `LIC-S8F-${RUN}`,
      licenseExpiry: new Date("2030-01-01"),
    },
  });
  fx.driver = driver.id;

  const vendor = await prisma.vendor.create({
    data: {
      businessName: `S8F Vendor ${RUN}`,
      contactName: "S8F Contact",
      email: email("vendor"),
      phone: "9779800000310",
      verificationStatus: "APPROVED",
      createdById: fx.adminUser,
    },
  });
  fx.vendor = vendor.id;
  fx.vendorName = vendor.businessName;

  const customer = await prisma.customer.create({
    data: {
      fullName: `S8F Customer ${RUN}`,
      phone: `977985${RUN.slice(0, 7)}`,
      normalizedPhone: `977985${RUN.slice(0, 7)}`,
    },
  });
  fx.customer = customer.id;
  fx.customerName = customer.fullName;

  financeActor = await actorFor(fx.financeUser);
  supportActor = await actorFor(fx.supportUser);
}, 120_000);

describe("Step 8 — finance console model", () => {
  it("reconciles every summary figure against DB truth and the module definitions", async () => {
    const today = domain.kathmanduToday();
    const range = { from: domain.addDays(today, -29), to: today };

    // Own-namespace cleanup: earlier runs of THIS suite plant at the
    // same fixed year-2000 instants (QUEUE_OLDEST), and the attention
    // windows (ASC take-5/10) fill with those tied leftovers, crowding
    // this run's rows out of the window assertions below. Delete only
    // rows carrying this suite's own prefixes/reasons — never another
    // suite's data — before the before-snapshot is captured, so the
    // delta assertions stay exact.
    const staleRemittances = await prisma.codRemittance.findMany({
      where: { remittanceNumber: { startsWith: "RMT-S8F-" } },
      select: { id: true },
    });
    if (staleRemittances.length > 0) {
      const staleIds = staleRemittances.map((r) => r.id);
      await prisma.codRemittanceLine.deleteMany({ where: { remittanceId: { in: staleIds } } });
      await prisma.codRemittance.deleteMany({ where: { id: { in: staleIds } } });
    }
    await prisma.financialAdjustment.deleteMany({
      where: { reason: { startsWith: "S8F adjustment " } },
    });
    await prisma.refund.deleteMany({ where: { reason: { startsWith: "S8F requested refund " } } });

    const consoleBefore = await financeHomeSvc.getFinanceConsole(financeActor);
    const reportBefore = await reportsFinanceSvc.getFinanceReport(financeActor, {});
    const codBefore = await reportsFinanceSvc.getCodReport(financeActor, range);

    // --- Plant unequal fixtures -------------------------------------------
    // Invoices in the period: ISSUED 1000.00, PARTIALLY_PAID 2000.00,
    // PAID 3000.00; a CANCELLED 9999.00 must NOT count as invoiced.
    const invIssued = await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-S8F-I-${RUN}`,
        vendorId: fx.vendor,
        subtotalPaisa: BigInt(1000_00),
        totalPaisa: BigInt(1000_00),
        status: "ISSUED",
        issuedById: fx.financeUser,
        issuedAt: new Date(),
      },
    });
    const invPartial = await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-S8F-P-${RUN}`,
        vendorId: fx.vendor,
        subtotalPaisa: BigInt(2000_00),
        totalPaisa: BigInt(2000_00),
        status: "PARTIALLY_PAID",
        issuedById: fx.financeUser,
        issuedAt: new Date(),
      },
    });
    await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-S8F-F-${RUN}`,
        vendorId: fx.vendor,
        subtotalPaisa: BigInt(3000_00),
        totalPaisa: BigInt(3000_00),
        status: "PAID",
        issuedById: fx.financeUser,
        issuedAt: new Date(),
      },
    });
    await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-S8F-X-${RUN}`,
        vendorId: fx.vendor,
        subtotalPaisa: BigInt(9999_00),
        totalPaisa: BigInt(9999_00),
        status: "CANCELLED",
        issuedById: fx.financeUser,
        issuedAt: new Date(),
      },
    });

    // Vendor payment 400.00 allocated to the partial invoice; a
    // customer payment 250.00 with no allocation and no invoice.
    const vendorPayment = await prisma.payment.create({
      data: {
        payerType: "VENDOR",
        payerVendorId: fx.vendor,
        amountPaisa: BigInt(400_00),
        method: "BANK_TRANSFER",
        status: "PAID",
        recordedById: fx.financeUser,
        paidAt: new Date(),
      },
    });
    fx.vendorPayment = vendorPayment.id;
    await prisma.paymentAllocation.create({
      data: {
        paymentId: vendorPayment.id,
        invoiceId: invPartial.id,
        amountPaisa: BigInt(400_00),
        allocatedById: fx.financeUser,
      },
    });
    const customerPayment = await prisma.payment.create({
      data: {
        payerType: "CUSTOMER",
        payerCustomerId: fx.customer,
        amountPaisa: BigInt(250_00),
        method: "CASH",
        status: "PAID",
        recordedById: fx.financeUser,
        paidAt: new Date(),
      },
    });
    fx.customerPayment = customerPayment.id;

    // Refunds: one PROCESSED in period (150.00), one REQUESTED.
    await prisma.refund.create({
      data: {
        paymentId: vendorPayment.id,
        amountPaisa: BigInt(150_00),
        reason: `S8F processed refund ${RUN}`,
        status: "PROCESSED",
        requestedById: fx.financeOther,
        processedById: fx.financeUser,
        processedAt: new Date(),
      },
    });
    const refundRequested = await prisma.refund.create({
      data: {
        paymentId: vendorPayment.id,
        amountPaisa: BigInt(30_00),
        reason: `S8F requested refund ${RUN}`,
        status: "REQUESTED",
        requestedById: fx.financeUser,
      },
    });
    fx.refundRequested = refundRequested.id;
    await prisma.refund.update({
      where: { id: refundRequested.id },
      data: { createdAt: QUEUE_OLDEST },
    });

    // Adjustment REQUESTED created by ANOTHER finance user.
    const adjustment = await prisma.financialAdjustment.create({
      data: {
        targetType: "INVOICE",
        targetId: invIssued.id,
        amountPaisa: BigInt(50_00),
        reason: `S8F adjustment ${RUN}`,
        status: "REQUESTED",
        createdById: fx.financeOther,
      },
    });
    fx.adjustment = adjustment.id;
    await prisma.financialAdjustment.update({
      where: { id: adjustment.id },
      data: { createdAt: QUEUE_OLDEST },
    });

    // Settlements: PENDING 800.00 + APPROVED 1200.00 count toward
    // vendor payables; a SETTLED 5000.00 must not.
    const settlementPending = await prisma.vendorSettlement.create({
      data: {
        settlementNumber: `SET-S8F-P-${RUN}`,
        vendorId: fx.vendor,
        periodStart: new Date(),
        periodEnd: new Date(),
        grossCodPaisa: BigInt(800_00),
        shippingChargesPaisa: BigInt(0),
        netPayablePaisa: BigInt(800_00),
        status: "PENDING",
        preparedById: fx.financeUser,
      },
    });
    fx.settlementPending = settlementPending.id;
    await prisma.vendorSettlement.create({
      data: {
        settlementNumber: `SET-S8F-A-${RUN}`,
        vendorId: fx.vendor,
        periodStart: new Date(),
        periodEnd: new Date(),
        grossCodPaisa: BigInt(1200_00),
        shippingChargesPaisa: BigInt(0),
        netPayablePaisa: BigInt(1200_00),
        status: "APPROVED",
        preparedById: fx.financeUser,
      },
    });
    await prisma.vendorSettlement.create({
      data: {
        settlementNumber: `SET-S8F-S-${RUN}`,
        vendorId: fx.vendor,
        periodStart: new Date(),
        periodEnd: new Date(),
        grossCodPaisa: BigInt(5000_00),
        shippingChargesPaisa: BigInt(0),
        netPayablePaisa: BigInt(5000_00),
        status: "SETTLED",
        preparedById: fx.financeUser,
      },
    });

    // Ledger shipping revenue in range: CREDIT 700.00 − DEBIT 200.00.
    const revenueAccount = await prisma.financialAccount.upsert({
      where: { code: "SHIPPING_REVENUE" },
      update: {},
      create: { code: "SHIPPING_REVENUE", name: "Shipping revenue", kind: "REVENUE", ownerType: "COMPANY" },
    });
    // The ledger's balance trigger requires each journal to balance
    // within its transaction, so the revenue legs are paired with
    // offsetting legs on a receivables account in ONE transaction:
    // SHIPPING_REVENUE nets CREDIT 700 − DEBIT 200 = +500.00 while
    // the journal as a whole balances (900.00 = 900.00).
    const offsetAccount = await prisma.financialAccount.upsert({
      where: { code: "ACCOUNTS_RECEIVABLE" },
      update: {},
      create: { code: "ACCOUNTS_RECEIVABLE", name: "Accounts receivable", kind: "ASSET", ownerType: "COMPANY" },
    });
    await prisma.$transaction(async (tx) => {
      const legs: {
        reference: string;
        accountId: string;
        direction: string;
        amountPaisa: bigint;
      }[] = [
        { reference: `LED-S8F-CR-${RUN}`, accountId: revenueAccount.id, direction: "CREDIT", amountPaisa: BigInt(700_00) },
        { reference: `LED-S8F-CRO-${RUN}`, accountId: offsetAccount.id, direction: "DEBIT", amountPaisa: BigInt(700_00) },
        { reference: `LED-S8F-DR-${RUN}`, accountId: revenueAccount.id, direction: "DEBIT", amountPaisa: BigInt(200_00) },
        { reference: `LED-S8F-DRO-${RUN}`, accountId: offsetAccount.id, direction: "CREDIT", amountPaisa: BigInt(200_00) },
      ];
      for (const leg of legs) {
        await tx.ledgerTransaction.create({
          data: {
            ...leg,
            journalRef: `S8F-REV-${RUN}`,
            type: "SHIPPING_CHARGE",
            occurredAt: new Date(),
            actorId: fx.financeUser,
          },
        });
      }
    });

    // COD: A never remitted (1000.00), B in a SUBMITTED remittance
    // (2000.00), C in a VERIFIED remittance fully verified (3000.00).
    fx.collA = await makeCollection("A", BigInt(1000_00));
    fx.collB = await makeCollection("B", BigInt(2000_00));
    fx.collC = await makeCollection("C", BigInt(3000_00));
    const remitSubmitted = await makeRemittance("SUB", "SUBMITTED", BigInt(2000_00));
    await prisma.codRemittance.update({
      where: { id: remitSubmitted },
      data: { submittedAt: QUEUE_OLDEST },
    });
    await prisma.codRemittanceLine.create({
      data: {
        remittanceId: remitSubmitted,
        codCollectionId: fx.collB,
        expectedPaisa: BigInt(2000_00),
        collectedPaisa: BigInt(2000_00),
      },
    });
    const remitVerifying = await makeRemittance("UV", "UNDER_VERIFICATION", BigInt(650_00));
    await prisma.codRemittance.update({
      where: { id: remitVerifying },
      data: { submittedAt: new Date("2000-01-02T00:00:00Z") },
    });
    const remitVerified = await makeRemittance("VER", "VERIFIED", BigInt(3000_00));
    await prisma.codRemittanceLine.create({
      data: {
        remittanceId: remitVerified,
        codCollectionId: fx.collC,
        expectedPaisa: BigInt(3000_00),
        collectedPaisa: BigInt(3000_00),
        verifiedPaisa: BigInt(3000_00),
      },
    });
    const remitDiscrepancy = await makeRemittance("DIS", "DISCREPANCY", BigInt(200_00), {
      countedAmountPaisa: BigInt(180_00),
      discrepancyPaisa: BigInt(-20_00),
    });
    await prisma.codRemittance.update({
      where: { id: remitDiscrepancy },
      data: { submittedAt: new Date("2000-01-03T00:00:00Z") },
    });

    // Accounts: a per-owner account (UUID-bearing code) must be
    // filtered out of the console strip; a system account stays.
    await prisma.financialAccount.create({
      data: {
        code: `VENDOR_PAYABLE:${fx.vendor}`,
        name: "S8F vendor payable",
        kind: "LIABILITY",
        ownerType: "VENDOR",
        ownerVendorId: fx.vendor,
      },
    });
    await prisma.financialAccount.create({
      data: {
        code: `S8FCLR${RUN}`,
        name: "S8F clearing",
        kind: "ASSET",
        ownerType: "COMPANY",
      },
    });

    // --- After -------------------------------------------------------------
    const model = await financeHomeSvc.getFinanceConsole(financeActor);
    const reportAfter = await reportsFinanceSvc.getFinanceReport(financeActor, {});
    const codAfter = await reportsFinanceSvc.getCodReport(financeActor, range);
    const overview = await financeOverviewSvc.getFinanceOverview(financeActor);

    // Period: exact composition equality with getFinanceReport…
    expect(model.period.from).toBe(reportAfter.range.from);
    expect(model.period.to).toBe(reportAfter.range.to);
    expect(model.period.invoiced).toEqual({
      count: reportAfter.invoiced.count,
      totalPaisa: reportAfter.invoiced.totalPaisa,
    });
    expect(model.period.paymentsReceived).toEqual({
      count: reportAfter.paymentsReceived.count,
      totalPaisa: reportAfter.paymentsReceived.totalPaisa,
    });
    expect(model.period.refunds).toEqual(reportAfter.refunds);
    // …and the report's own deltas equal the planted truth (CANCELLED
    // excluded from invoiced; both PAID payments counted).
    expect(reportAfter.invoiced.count - reportBefore.invoiced.count).toBe(3);
    expect(BigInt(reportAfter.invoiced.totalPaisa) - BigInt(reportBefore.invoiced.totalPaisa)).toBe(BigInt(6000_00));
    expect(reportAfter.paymentsReceived.count - reportBefore.paymentsReceived.count).toBe(2);
    expect(
      BigInt(reportAfter.paymentsReceived.totalPaisa) - BigInt(reportBefore.paymentsReceived.totalPaisa),
    ).toBe(BigInt(650_00));
    expect(reportAfter.refunds.processedCount - reportBefore.refunds.processedCount).toBe(1);
    expect(BigInt(reportAfter.refunds.processedPaisa) - BigInt(reportBefore.refunds.processedPaisa)).toBe(BigInt(150_00));
    expect(reportAfter.refunds.requestedOpen - reportBefore.refunds.requestedOpen).toBe(1);

    // Shipping revenue: ledger CREDIT − DEBIT delta = 500.00, and the
    // console carries the finance-home figure for the same range.
    expect(
      BigInt(model.summary.revenueLast30DaysPaisa) - BigInt(consoleBefore.summary.revenueLast30DaysPaisa),
    ).toBe(BigInt(500_00));

    // Outstanding: exact equality with the overview definition, and
    // the delta equals ISSUED 1000 + (PARTIAL 2000 − allocated 400).
    expect(model.summary.outstandingReceivablesPaisa).toBe(overview.openInvoices.outstandingPaisa);
    expect(model.summary.openInvoicesCount).toBe(overview.openInvoices.count);
    expect(
      BigInt(model.summary.outstandingReceivablesPaisa) -
        BigInt(consoleBefore.summary.outstandingReceivablesPaisa),
    ).toBe(BigInt(2600_00));
    expect(model.summary.openInvoicesCount - consoleBefore.summary.openInvoicesCount).toBe(2);

    // Vendor payables: delta = PENDING 800 + APPROVED 1200 (SETTLED
    // excluded), and the absolute figure equals the listSettlements
    // PENDING + APPROVED sums.
    expect(BigInt(model.summary.vendorPayablePaisa) - BigInt(consoleBefore.summary.vendorPayablePaisa)).toBe(
      BigInt(2000_00),
    );
    const [pendingList, approvedList] = await Promise.all([
      settlementsSvc.listSettlements(financeActor, { status: "PENDING", pageSize: 100 }),
      settlementsSvc.listSettlements(financeActor, { status: "APPROVED", pageSize: 100 }),
    ]);
    expect(pendingList.items.length).toBe(pendingList.meta.total);
    expect(approvedList.items.length).toBe(approvedList.meta.total);
    const listSum = [...pendingList.items, ...approvedList.items].reduce(
      (sum, row) => sum + BigInt(row.netPayablePaisa),
      BigInt(0),
    );
    expect(model.summary.vendorPayablePaisa).toBe(listSum.toString());

    // COD: (a) independent all-collections DB truth computed here.
    const allCollections = await prisma.deliveryCodCollection.findMany({
      select: {
        collectedPaisa: true,
        remittanceLines: {
          select: {
            collectedPaisa: true,
            verifiedPaisa: true,
            remittance: { select: { status: true, resolution: true } },
          },
        },
      },
    });
    let tCollected = BigInt(0);
    let tVerified = BigInt(0);
    let tAwaiting = BigInt(0);
    let tInOpen = BigInt(0);
    for (const c of allCollections) {
      const line = c.remittanceLines[0];
      const isVerified =
        line !== undefined &&
        (line.remittance.status === "VERIFIED" ||
          (line.remittance.status === "CLOSED" && line.remittance.resolution === "ACCEPTED_COUNTED"));
      const verified = isVerified ? (line.verifiedPaisa ?? BigInt(0)) : BigInt(0);
      let awaiting = BigInt(0);
      let inOpen = BigInt(0);
      if (!line) awaiting = c.collectedPaisa;
      else if (isVerified) {
        const tail = c.collectedPaisa - verified;
        if (tail > BigInt(0)) inOpen = tail;
      } else if (line.remittance.status !== "CLOSED") inOpen = line.collectedPaisa;
      else awaiting = c.collectedPaisa;
      tCollected += c.collectedPaisa;
      tVerified += verified;
      tAwaiting += awaiting;
      tInOpen += inOpen;
    }
    expect(model.summary.cod).toEqual({
      collectedPaisa: tCollected.toString(),
      awaitingRemittancePaisa: tAwaiting.toString(),
      inOpenRemittancePaisa: tInOpen.toString(),
      remittedVerifiedPaisa: tVerified.toString(),
      outstandingPaisa: (tCollected - tVerified).toString(),
    });
    // (b) deltas equal getCodReport's totals deltas over the fixture
    // range, and equal the planted classification.
    const codDelta = (after: string, before: string) => BigInt(after) - BigInt(before);
    expect(codDelta(model.summary.cod.collectedPaisa, consoleBefore.summary.cod.collectedPaisa)).toBe(BigInt(6000_00));
    expect(codDelta(codAfter.totals.collectedPaisa, codBefore.totals.collectedPaisa)).toBe(BigInt(6000_00));
    expect(codDelta(model.summary.cod.awaitingRemittancePaisa, consoleBefore.summary.cod.awaitingRemittancePaisa)).toBe(BigInt(1000_00));
    expect(codDelta(codAfter.totals.awaitingRemittancePaisa, codBefore.totals.awaitingRemittancePaisa)).toBe(BigInt(1000_00));
    expect(codDelta(model.summary.cod.inOpenRemittancePaisa, consoleBefore.summary.cod.inOpenRemittancePaisa)).toBe(BigInt(2000_00));
    expect(codDelta(codAfter.totals.inOpenRemittancePaisa, codBefore.totals.inOpenRemittancePaisa)).toBe(BigInt(2000_00));
    expect(codDelta(model.summary.cod.outstandingPaisa, consoleBefore.summary.cod.outstandingPaisa)).toBe(BigInt(3000_00));
    expect(codDelta(codAfter.totals.outstandingPaisa, codBefore.totals.outstandingPaisa)).toBe(BigInt(3000_00));
    expect(codDelta(codAfter.totals.remittedVerifiedPaisa, codBefore.totals.remittedVerifiedPaisa)).toBe(BigInt(3000_00));

    // Pending queues: counts move by the planted amounts and equal
    // the queues' own counts; planted rows are present, field-mapped.
    expect(model.pending.settlements.count - consoleBefore.pending.settlements.count).toBe(1);
    expect(model.pending.settlements.count).toBe(pendingList.meta.total);
    const plantedSettlement = model.pending.settlements.items.find((i) => i.id === fx.settlementPending);
    expect(plantedSettlement).toMatchObject({
      settlementNumber: `SET-S8F-P-${RUN}`,
      vendorName: fx.vendorName,
      netPayablePaisa: "80000",
    });

    expect(model.pending.adjustments.count - consoleBefore.pending.adjustments.count).toBe(1);
    const plantedAdjustment = model.pending.adjustments.items.find((i) => i.id === fx.adjustment);
    expect(plantedAdjustment).toMatchObject({
      creatorName: "S8F finance-other",
      amountPaisa: "5000",
      awaiting: "ACTIONABLE_BY_ACTOR",
    });
    expect(model.pending.refunds.count - consoleBefore.pending.refunds.count).toBe(1);
    const plantedRefund = model.pending.refunds.items.find((i) => i.id === fx.refundRequested);
    expect(plantedRefund).toMatchObject({
      requesterName: "S8F finance",
      amountPaisa: "3000",
      awaiting: "AWAITING_ANOTHER_APPROVER",
    });

    expect(model.pending.remittances.count - consoleBefore.pending.remittances.count).toBe(2);
    // Merged oldest-first across SUBMITTED + UNDER_VERIFICATION. The
    // queue fixtures plant at fixed year-2000 instants (QUEUE_OLDEST),
    // so on an accumulated bla_test the per-status newest-5 windows
    // fill with tied rows from earlier runs — which planted rows land
    // in the merged window is population-dependent (the Step 5
    // a52f36c trap class). The deterministic contract is exact: the
    // model's items equal the in-test merge of the two source list
    // calls under the console's own rule (concat, sort by submittedAt
    // ascending, take 5).
    const [subList, uvList] = await Promise.all([
      codRemittancesSvc.listRemittances(financeActor, { status: "SUBMITTED", pageSize: 5 }),
      codRemittancesSvc.listRemittances(financeActor, { status: "UNDER_VERIFICATION", pageSize: 5 }),
    ]);
    const expectedQueue = [...subList.items, ...uvList.items]
      .sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0))
      .slice(0, 5)
      .map((i) => i.remittanceNumber);
    expect(model.pending.remittances.items.map((i) => i.remittanceNumber)).toEqual(expectedQueue);
    expect(model.pending.remittanceDiscrepancies.count - consoleBefore.pending.remittanceDiscrepancies.count).toBe(1);
    expect(
      model.pending.remittanceDiscrepancies.items.map((i) => i.remittanceNumber),
    ).toContain(`RMT-S8F-DIS-${RUN}`);

    // Recent invoices include the planted ISSUED invoice, mapped.
    expect(model.recentInvoices.map((i) => i.invoiceNumber)).toContain(`INV-S8F-I-${RUN}`);

    // Recent payments: payer names resolved per payer kind, and the
    // drill invoice comes from the first allocation (vendor payment)
    // or is null (customer payment → ledger).
    const vp = model.recentPayments.find((p) => p.id === fx.vendorPayment);
    expect(vp).toMatchObject({
      amountPaisa: "40000",
      method: "BANK_TRANSFER",
      payerType: "VENDOR",
      payerName: fx.vendorName,
      invoiceId: invPartial.id,
    });
    const cp = model.recentPayments.find((p) => p.id === fx.customerPayment);
    expect(cp).toMatchObject({ payerType: "CUSTOMER", payerName: fx.customerName, invoiceId: null });

    // Accounts strip: system accounts only — no code contains ":".
    expect(model.accounts.every((a) => !a.code.includes(":"))).toBe(true);
    expect(model.accounts.map((a) => a.code)).toContain(`S8FCLR${RUN}`);
    expect(model.accounts.map((a) => a.code)).not.toContain(`VENDOR_PAYABLE:${fx.vendor}`);
    const revenue = model.accounts.find((a) => a.code === "SHIPPING_REVENUE");
    if (revenue) expect(revenue.label).toBe("Shipping revenue");

    // can map reflects the FINANCE role's catalog grants.
    expect(model.can).toEqual({
      createInvoice: true,
      recordPayment: true,
      viewLedger: true,
      codRemittances: true,
      settlements: true,
      reports: true,
    });

    // Today strip composes the finance-home operations figures. The
    // console's operationsToday deliberately carries only the two
    // today flows (invoices issued, payments received) — settlement
    // figures live in pending/summary — so equality is asserted on
    // exactly the carried fields, not the source's full shape.
    const home = await financeHomeSvc.getFinanceHome(financeActor);
    expect(model.operationsToday).toEqual({
      invoicesIssued: home.operationsToday.invoicesIssued,
      paymentsReceived: home.operationsToday.paymentsReceived,
    });
    expect(model.today).toBe(home.today);
  }, 60_000);

  it("a non-finance actor (SUPPORT) is refused", async () => {
    expect(supportActor.permissions.has("finance.read")).toBe(false);
    await expect(financeHomeSvc.getFinanceConsole(supportActor)).rejects.toThrow();
  }, 60_000);
});
