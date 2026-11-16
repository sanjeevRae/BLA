import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * V2 Phase 2 permission reconciliation tests (audit H-3, M-1, M-7)
 * against the local bla_test database.
 *
 *  H-3  CUSTOMER is granted `notification.read_own`: a customer can
 *       read, list and mark-read their own IN_APP notifications end
 *       to end, and cannot touch another customer's notification.
 *  M-1  FINANCE is granted `finance.approve_adjustment`: finance can
 *       now decide adjustments and refunds, but four-eyes still
 *       binds — the creator/requester can never approve their own
 *       item; a second finance user must decide. WAREHOUSE_STAFF
 *       still holds no approval permission at all.
 *  M-7  The dead staff create routes (/staff/transfers/new,
 *       /staff/deliveries/new) are deleted; the warehouse variants
 *       remain.
 *
 * Fixtures are deliberately light (direct Prisma rows for the
 * vendor / invoice / payment the finance flows need, plus the same
 * chart-of-accounts seeding the Phase 7 suites use) — the full
 * delivery journey is already covered by finance.test.ts.
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
const email = (label: string) => `p2a-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);

let prisma: import("@prisma/client").PrismaClient;
let notificationsSvc: typeof import("@/server/services/notifications");
let adjustmentsSvc: typeof import("@/server/services/finance-adjustments");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");
let financeDomain: typeof import("@/lib/finance/domain");

const fx: Record<string, string> = {};
let financeAActor: Awaited<ReturnType<typeof actorFor>>;
let financeBActor: Awaited<ReturnType<typeof actorFor>>;
let customerAActor: Awaited<ReturnType<typeof actorFor>>;
let customerBActor: Awaited<ReturnType<typeof actorFor>>;
let staffActor: Awaited<ReturnType<typeof actorFor>>;

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
      fullName: `P2A ${label}`,
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

async function journalSums(journalRef: string): Promise<{ debits: bigint; credits: bigint; count: number }> {
  const entries = await prisma.ledgerTransaction.findMany({ where: { journalRef } });
  let debits = BigInt(0);
  let credits = BigInt(0);
  for (const entry of entries) {
    if (entry.direction === "DEBIT") debits += entry.amountPaisa;
    else credits += entry.amountPaisa;
  }
  return { debits, credits, count: entries.length };
}

async function expectBalanced(journalRef: string, amount: bigint) {
  const sums = await journalSums(journalRef);
  expect(sums.count).toBeGreaterThan(0);
  expect(sums.debits).toBe(amount);
  expect(sums.credits).toBe(amount);
  return sums;
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
  notificationsSvc = await import("@/server/services/notifications");
  adjustmentsSvc = await import("@/server/services/finance-adjustments");
  errors = await import("@/lib/errors");
  actorErrors = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");
  financeDomain = await import("@/lib/finance/domain");

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

  // Phase 7 chart of accounts (same upserts as the seed).
  for (const account of financeDomain.COMPANY_ACCOUNTS) {
    await prisma.financialAccount.upsert({
      where: { code: account.code },
      update: { name: account.name, kind: account.kind },
      create: { code: account.code, name: account.name, kind: account.kind, ownerType: "COMPANY" },
    });
  }

  fx.adminUser = await makeUser("admin", "ADMIN");
  fx.financeAUser = await makeUser("financeA", "FINANCE");
  financeAActor = await actorFor(fx.financeAUser);
  fx.financeBUser = await makeUser("financeB", "FINANCE");
  financeBActor = await actorFor(fx.financeBUser);

  // Warehouse fixture for the staff actor's membership scope.
  const warehouse =
    (await prisma.warehouse.findUnique({ where: { code: "WH-QA2-01" } })) ??
    (await prisma.warehouse.create({
      data: {
        code: "WH-QA2-01",
        name: "P2A Warehouse (shared fixture)",
        type: "REGIONAL",
        status: "ACTIVE",
        district: "P2A District",
        city: "P2A City",
        province: "Bagmati",
        country: "Nepal",
      },
    }));
  if (warehouse.status !== "ACTIVE") {
    await prisma.warehouse.update({ where: { id: warehouse.id }, data: { status: "ACTIVE" } });
  }
  fx.wh = warehouse.id;
  fx.staffUser = await makeUser("staff", "WAREHOUSE_STAFF");
  await addMembership(fx.staffUser, fx.wh, "WAREHOUSE_STAFF");
  staffActor = await actorFor(fx.staffUser);

  // Two customers, each with a Customer profile linked to the user
  // (actorFor resolves customerId through that link).
  for (const [label, n] of [
    ["customerA", 201],
    ["customerB", 202],
  ] as const) {
    const userId = await makeUser(label, "CUSTOMER");
    await prisma.customer.create({
      data: {
        fullName: `P2A ${label}`,
        phone: phone(n),
        normalizedPhone: phone(n),
        email: email(`${label}-profile`),
        userId,
        createdById: fx.adminUser,
      },
    });
    fx[`${label}User`] = userId;
  }
  customerAActor = await actorFor(fx.customerAUser);
  customerBActor = await actorFor(fx.customerBUser);

  // Direct vendor + invoice fixtures for the finance flows.
  const vendor = await prisma.vendor.create({
    data: {
      businessName: `P2A Vendor ${RUN}`,
      contactName: "P2A Contact",
      email: email("vendor"),
      phone: phone(11),
      verificationStatus: "APPROVED",
      billingPreference: "COD_OFFSET",
      createdById: fx.adminUser,
    },
  });
  fx.vendor = vendor.id;

  const invoiceTotal = BigInt(100000);
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `P2A-INV-${RUN}`,
      vendorId: vendor.id,
      subtotalPaisa: invoiceTotal,
      totalPaisa: invoiceTotal,
      status: "ISSUED",
      issuedById: fx.adminUser,
    },
  });
  await prisma.invoiceLine.create({
    data: {
      invoiceId: invoice.id,
      kind: "SHIPPING_CHARGE",
      description: "P2A fixture shipping charge",
      amountPaisa: invoiceTotal,
    },
  });
  fx.invoice = invoice.id;
  fx.invoiceTotal = invoiceTotal.toString();

  // A second, UNPAID invoice for the adjustment flow: a credit
  // note's approval bound is total minus paid components, so the
  // fully-allocated invoice above has no room for one.
  const adjInvoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `P2A-INV-ADJ-${RUN}`,
      vendorId: vendor.id,
      subtotalPaisa: invoiceTotal,
      totalPaisa: invoiceTotal,
      status: "ISSUED",
      issuedById: fx.adminUser,
    },
  });
  await prisma.invoiceLine.create({
    data: {
      invoiceId: adjInvoice.id,
      kind: "SHIPPING_CHARGE",
      description: "P2A fixture shipping charge (adjustment target)",
      amountPaisa: invoiceTotal,
    },
  });
  fx.invoiceAdj = adjInvoice.id;

  // A paid vendor payment allocated in full to the invoice, so the
  // refund flow has an honest payment + allocation to reverse.
  const payment = await prisma.payment.create({
    data: {
      invoiceId: invoice.id,
      payerType: "VENDOR",
      payerVendorId: vendor.id,
      amountPaisa: invoiceTotal,
      method: "BANK_TRANSFER",
      status: "PAID",
      paidAt: new Date(),
      recordedById: fx.financeAUser,
    },
  });
  await prisma.paymentAllocation.create({
    data: {
      paymentId: payment.id,
      invoiceId: invoice.id,
      amountPaisa: invoiceTotal,
      allocatedById: fx.financeAUser,
    },
  });
  fx.payment = payment.id;
});

describe("Phase 2 permission reconciliation", { timeout: 120000 }, () => {
  it("H-3: a customer reads, lists and marks read their own notifications; another customer cannot", async () => {
    expect(customerAActor.permissions.has("notification.read_own")).toBe(true);

    const created = await notificationsSvc.createNotificationInTx(prisma, {
      userId: fx.customerAUser,
      category: "GENERAL",
      title: "P2A delivery update",
      body: "Your parcel is on its way.",
      dedupeKey: `p2a-note-${RUN}`,
      channels: ["IN_APP"],
    });
    expect(created).toBe(1);
    const row = await prisma.notification.findFirstOrThrow({
      where: { dedupeKey: `p2a-note-${RUN}:IN_APP` },
    });
    expect(row.userId).toBe(fx.customerAUser);

    // The bell count and the inbox both see it now (pre-Phase 2 the
    // count silently returned 0 and the list call 403'd).
    const unread = await notificationsSvc.getMyUnreadCount(customerAActor);
    expect(unread.count).toBeGreaterThan(0);
    const list = await notificationsSvc.listMyNotifications(customerAActor, {});
    expect(list.items.map((i) => i.id)).toContain(row.id);
    expect(list.unreadCount).toBeGreaterThan(0);

    const marked = await notificationsSvc.markNotificationRead(customerAActor, row.id);
    expect(marked.readAt).not.toBeNull();
    const after = await notificationsSvc.getMyUnreadCount(customerAActor);
    expect(after.count).toBe(0);

    // A second customer is fully isolated: empty inbox, and marking
    // the first customer's notification read is an audited denial.
    const otherList = await notificationsSvc.listMyNotifications(customerBActor, {});
    expect(otherList.items).toEqual([]);
    await expect(
      notificationsSvc.markNotificationRead(customerBActor, row.id),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });

  it("M-1: finance adjustments run four-eyes between two finance users and post a balanced journal", async () => {
    expect(financeAActor.permissions.has("finance.approve_adjustment")).toBe(true);

    const credit = BigInt(40000);
    const adjustment = await adjustmentsSvc.createAdjustment(financeAActor, {
      targetType: "INVOICE",
      targetId: fx.invoiceAdj,
      amountPaisa: credit.toString(),
      reason: "P2A goodwill credit for a delayed delivery",
    });
    expect(adjustment.status).toBe("REQUESTED");

    // The creator cannot approve their own adjustment (four-eyes) —
    // this is now a DomainValidationError, not a permission denial:
    // FINANCE holds the grant, the separation rule is what binds.
    await expect(
      adjustmentsSvc.approveAdjustment(financeAActor, adjustment.id),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);

    // A second finance user approves; the credit note applies and
    // its ledger journal is posted and balanced.
    const applied = await adjustmentsSvc.approveAdjustment(financeBActor, adjustment.id);
    expect(applied.status).toBe("APPLIED");
    expect(applied.ledgerJournalRef).toBe(`ADJ-${adjustment.id}`);
    await expectBalanced(`ADJ-${adjustment.id}`, credit);

    const row = await prisma.financialAdjustment.findUniqueOrThrow({
      where: { id: adjustment.id },
    });
    expect(row.status).toBe("APPLIED");
    expect(row.approvedById).toBe(fx.financeBUser);
  });

  it("M-1: warehouse staff still cannot approve adjustments (grant stays finance-scoped)", async () => {
    const adjustment = await adjustmentsSvc.createAdjustment(financeAActor, {
      targetType: "INVOICE",
      targetId: fx.invoiceAdj,
      amountPaisa: "1000",
      reason: "P2A probe adjustment for the staff denial",
    });
    await expect(
      adjustmentsSvc.approveAdjustment(staffActor, adjustment.id),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const row = await prisma.financialAdjustment.findUniqueOrThrow({
      where: { id: adjustment.id },
    });
    expect(row.status).toBe("REQUESTED");
  });

  it("M-1: finance refunds run four-eyes between two finance users, then process", async () => {
    const refundAmount = "25000";
    const refund = await adjustmentsSvc.requestRefund(financeAActor, {
      paymentId: fx.payment,
      amountPaisa: refundAmount,
      reason: "P2A vendor overcharged on a duplicate booking",
    });
    expect(refund.status).toBe("REQUESTED");

    // The requester cannot approve their own refund.
    await expect(adjustmentsSvc.approveRefund(financeAActor, refund.id)).rejects.toBeInstanceOf(
      errors.DomainValidationError,
    );

    const approved = await adjustmentsSvc.approveRefund(financeBActor, refund.id);
    expect(approved.status).toBe("APPROVED");

    const processed = await adjustmentsSvc.processRefund(financeBActor, refund.id);
    expect(processed.status).toBe("PROCESSED");
    await expectBalanced(`REF-${refund.id}`, BigInt(refundAmount));

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: fx.payment } });
    expect(payment.status).toBe("PARTIALLY_REFUNDED");
    expect(payment.amountPaisa).toBe(BigInt(fx.invoiceTotal)); // original never edited
  });

  it("M-7: the dead staff create routes are gone; the warehouse variants remain", () => {
    const appRoot = join(process.cwd(), "src/app/(dashboards)");
    expect(existsSync(join(appRoot, "staff/transfers/new/page.tsx"))).toBe(false);
    expect(existsSync(join(appRoot, "staff/deliveries/new/page.tsx"))).toBe(false);
    expect(existsSync(join(appRoot, "warehouse/transfers/new/page.tsx"))).toBe(true);
    expect(existsSync(join(appRoot, "warehouse/deliveries/new/page.tsx"))).toBe(true);
  });
});
