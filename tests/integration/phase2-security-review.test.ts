import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 2 V2 — INDEPENDENT security review (adversarial PoCs).
 * Written by the reviewer, not the Phase 2 implementer. Prefix P2R.
 *
 * Areas: payment fingerprint canonicalisation + legacy-null
 * exemption + paidAt exclusion; DB journal-balance trigger
 * (UPDATE / sequential-append / concurrent-split bypass attempts);
 * invitation per-IP limiter (victim-IP burn via the documented
 * header-trust assumption, race counting, parse-before-check gap,
 * expired-token oracle); FINANCE four-eyes under the new
 * finance.approve_adjustment grant (self-approve, self-reject,
 * concurrent approve); L-2 movement-touch scope (full-history
 * disclosure, unscoped SUPPORT control, membership-less RIDER);
 * CUSTOMER notification.read_own isolation (incl. userId-NULL
 * TRACKING/OTP rows, mark-all, preferences); deleted staff create
 * routes + direct service calls by a staff actor.
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
const email = (label: string) => `p2r-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);
const GENERIC = "Invitation is invalid or has already been used";
const ipOctet = (parseInt(RUN.slice(-4), 36) % 170) + 20;
const IP_VICTIM = `198.51.100.${ipOctet}`;
const IP_FRESH = `198.51.100.${ipOctet + 1}`;
const IP_RACE = `203.0.113.${ipOctet}`;
const IP_MALFORMED = `203.0.113.${ipOctet + 1}`;
const IP_EXPIRED = `203.0.113.${ipOctet + 2}`;

let prisma: import("@prisma/client").PrismaClient;
let bookingsSvc: typeof import("@/server/services/bookings");
let vendorsSvc: typeof import("@/server/services/vendors");
let inventorySvc: typeof import("@/server/services/inventory");
let transfersSvc: typeof import("@/server/services/transfers");
let deliveriesSvc: typeof import("@/server/services/deliveries");
let invoicesSvc: typeof import("@/server/services/invoices");
let adjustmentsSvc: typeof import("@/server/services/finance-adjustments");
let invitationsSvc: typeof import("@/server/services/invitations");
let notificationsSvc: typeof import("@/server/services/notifications");
let clientIp: typeof import("@/lib/auth/client-ip");
let settlementsSvc: typeof import("@/server/services/settlements");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");
let financeDomain: typeof import("@/lib/finance/domain");

const fx: Record<string, string> = {};
let serviceCode = "";
type Actor = Awaited<ReturnType<typeof actorFor>>;
let adminActor: Actor;
let financeActor: Actor;
let finance2Actor: Actor;
let finance3Actor: Actor;
let waAActor: Actor;
let waBActor: Actor;
let staffAActor: Actor;
let supportActor: Actor;
let riderActor: Actor;
let customerActor: Actor;

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
      fullName: `P2R ${label} ${RUN}`,
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

const ZONE_DEFS = [
  { code: "ZONE-REC", name: "Receiving", kind: "RECEIVING" },
  { code: "ZONE-INS", name: "Inspection", kind: "INSPECTION" },
  { code: "ZONE-STO", name: "Storage", kind: "STORAGE" },
  { code: "ZONE-DSP", name: "Dispatch", kind: "DISPATCH" },
  { code: "ZONE-DMG", name: "Damaged / Quarantine", kind: "DAMAGED" },
] as const;

async function ensureWarehouse(code: string, name: string, district: string) {
  const existing = await prisma.warehouse.findUnique({ where: { code } });
  const warehouse =
    existing ??
    (await prisma.warehouse.create({
      data: {
        code, name, type: "REGIONAL", status: "ACTIVE",
        district, city: name, province: "Bagmati", country: "Nepal",
      },
    }));
  if (warehouse.status !== "ACTIVE") {
    await prisma.warehouse.update({ where: { id: warehouse.id }, data: { status: "ACTIVE" } });
  }
  await prisma.serviceArea.upsert({
    where: { district_name: { district, name: `${name} Area (shared)` } },
    update: { servingWarehouseId: warehouse.id, isActive: true },
    create: {
      name: `${name} Area (shared)`, district, city: name,
      province: "Bagmati", servingWarehouseId: warehouse.id,
    },
  });
  const locations: Record<string, string> = {};
  for (const def of ZONE_DEFS) {
    const zone = await prisma.warehouseZone.upsert({
      where: { warehouseId_code: { warehouseId: warehouse.id, code: def.code } },
      update: { isActive: true },
      create: { warehouseId: warehouse.id, code: def.code, name: def.name, kind: def.kind },
    });
    const location =
      (await prisma.storageLocation.findUnique({
        where: { fullCode: `${code}/${def.code}/R1` },
      })) ??
      (await prisma.storageLocation.create({
        data: { zoneId: zone.id, rack: "R1", fullCode: `${code}/${def.code}/R1` },
      }));
    locations[def.kind] = location.id;
  }
  return { id: warehouse.id, locations };
}

let invoiceSeq = 0;
async function makePayableInvoice(vendorId: string, totalPaisa: bigint) {
  invoiceSeq += 1;
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-P2R-${RUN}-${invoiceSeq}`,
      vendorId,
      subtotalPaisa: totalPaisa,
      discountPaisa: BigInt(0),
      taxPaisa: BigInt(0),
      totalPaisa,
      status: "ISSUED",
      dueAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      issuedById: fx.adminUser,
    },
  });
  return { id: invoice.id, totalPaisa: totalPaisa.toString() };
}

let legSeq = 0;
function directLeg(journalRef: string, accountId: string, direction: "DEBIT" | "CREDIT", amountPaisa: bigint) {
  legSeq += 1;
  return {
    reference: `TXN-P2R-${RUN}-${legSeq}`,
    journalRef, accountId, direction, amountPaisa,
    type: "PAYMENT_RECEIVED",
    occurredAt: new Date(),
    actorId: fx.adminUser,
  };
}

async function journalSums(journalRef: string) {
  const rows = await prisma.ledgerTransaction.findMany({ where: { journalRef } });
  let debits = BigInt(0), credits = BigInt(0);
  for (const r of rows) {
    if (r.direction === "DEBIT") debits += r.amountPaisa;
    else credits += r.amountPaisa;
  }
  return { debits, credits, count: rows.length };
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
  inventorySvc = await import("@/server/services/inventory");
  transfersSvc = await import("@/server/services/transfers");
  deliveriesSvc = await import("@/server/services/deliveries");
  invoicesSvc = await import("@/server/services/invoices");
  adjustmentsSvc = await import("@/server/services/finance-adjustments");
  invitationsSvc = await import("@/server/services/invitations");
  notificationsSvc = await import("@/server/services/notifications");
  settlementsSvc = await import("@/server/services/settlements");
  clientIp = await import("@/lib/auth/client-ip");
  errors = await import("@/lib/errors");
  actorErrors = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");
  financeDomain = await import("@/lib/finance/domain");

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
  for (const account of financeDomain.COMPANY_ACCOUNTS) {
    await prisma.financialAccount.upsert({
      where: { code: account.code },
      update: { name: account.name, kind: account.kind },
      create: { code: account.code, name: account.name, kind: account.kind, ownerType: "COMPANY" },
    });
  }

  fx.adminUser = await makeUser("admin", "ADMIN");
  adminActor = await actorFor(fx.adminUser);
  fx.financeUser = await makeUser("finance", "FINANCE");
  financeActor = await actorFor(fx.financeUser);
  fx.finance2User = await makeUser("finance2", "FINANCE");
  finance2Actor = await actorFor(fx.finance2User);
  fx.finance3User = await makeUser("finance3", "FINANCE");
  finance3Actor = await actorFor(fx.finance3User);

  fx.districtA = "P2RAlpha District";
  fx.districtB = "P2RBeta District";
  const a = await ensureWarehouse("WH-QR2-01", "P2R Alpha (shared fixture)", fx.districtA);
  fx.whA = a.id;
  const b = await ensureWarehouse("WH-QR2-02", "P2R Beta (shared fixture)", fx.districtB);
  fx.whB = b.id;

  fx.waA = await makeUser("waA", "WAREHOUSE_ADMIN");
  await addMembership(fx.waA, fx.whA, "WAREHOUSE_ADMIN");
  waAActor = await actorFor(fx.waA);
  fx.waB = await makeUser("waB", "WAREHOUSE_ADMIN");
  await addMembership(fx.waB, fx.whB, "WAREHOUSE_ADMIN");
  waBActor = await actorFor(fx.waB);
  fx.staffA = await makeUser("staffA", "WAREHOUSE_STAFF");
  await addMembership(fx.staffA, fx.whA, "WAREHOUSE_STAFF");
  staffAActor = await actorFor(fx.staffA);
  fx.supportUser = await makeUser("support", "SUPPORT");
  supportActor = await actorFor(fx.supportUser);
  fx.riderUser = await makeUser("rider", "RIDER");
  riderActor = await actorFor(fx.riderUser);

  fx.customerUser = await makeUser("customer", "CUSTOMER");
  const customer = await prisma.customer.create({
    data: {
      fullName: `P2R Customer ${RUN}`,
      phone: phone(77),
      normalizedPhone: phone(77),
      email: email("customer-profile"),
      userId: fx.customerUser,
    },
  });
  fx.customerProfile = customer.id;
  customerActor = await actorFor(fx.customerUser);

  serviceCode = `P2RSTD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P2R Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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

  const vendor = await vendorsSvc.createVendor(adminActor, {
    businessName: `P2R Vendor ${RUN}`,
    contactName: "P2R Contact",
    email: email("vendor"),
    phone: phone(11),
    billingPreference: "COD_OFFSET",
    creditLimitPaisa: null,
    registrationNumber: null,
  });
  await vendorsSvc.setVendorVerificationStatus(adminActor, vendor.id, { target: "UNDER_REVIEW", notes: null });
  await vendorsSvc.setVendorVerificationStatus(adminActor, vendor.id, { target: "APPROVED", notes: null });
  fx.vendor = vendor.id;
}, 180_000);

// ---------------------------------------------------------------------
// 1) Payment fingerprint
// ---------------------------------------------------------------------

describe("fingerprint canonicalisation", { timeout: 120_000 }, () => {
  it("F-1 regression: replay with a DIFFERENT client-supplied paidAt conflicts (paidAt is fingerprinted)", async () => {
    const inv = await makePayableInvoice(fx.vendor, BigInt(1000000));
    const key = `p2r-fp-paidat-${RUN}`;
    const base = {
      amountPaisa: "100000",
      method: "BANK_TRANSFER" as const,
      transactionRef: `P2R-REF-A-${RUN}`,
      idempotencyKey: key,
      allocations: [{ invoiceId: inv.id, amountPaisa: "100000" }],
    };
    const first = await invoicesSvc.recordPayment(financeActor, {
      ...base,
      paidAt: "2026-01-15T00:00:00.000Z",
    });
    expect(first.paidAt).toContain("2026-01-15");
    // Same key, same fingerprinted fields, but a paidAt five months
    // later — a materially different recorded payment (stored paidAt
    // AND the journal's occurredAt derive from it). The original
    // review probe showed this collapsing silently; after the F-1
    // fix (paidAt included in the fingerprint) it must conflict.
    await expect(
      invoicesSvc.recordPayment(financeActor, {
        ...base,
        paidAt: "2026-06-15T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    // A faithful replay — identical payload including paidAt —
    // still returns the original payment.
    const faithful = await invoicesSvc.recordPayment(financeActor, {
      ...base,
      paidAt: "2026-01-15T00:00:00.000Z",
    });
    expect(faithful.id).toBe(first.id);
    expect(faithful.paidAt).toContain("2026-01-15");
    expect(await prisma.payment.count({ where: { idempotencyKey: key } })).toBe(1);
    const legs = await prisma.ledgerTransaction.findMany({
      where: { journalRef: `PAY-${first.id}` },
    });
    expect(legs.length).toBe(2);
    for (const leg of legs) {
      expect(leg.occurredAt.toISOString()).toContain("2026-01-15");
    }
  });

  it("control: allocation order, leading-zero amounts and a padded transactionRef do NOT change the fingerprint", async () => {
    const inv1 = await makePayableInvoice(fx.vendor, BigInt(1000000));
    const inv2 = await makePayableInvoice(fx.vendor, BigInt(1000000));
    const key = `p2r-fp-canon-${RUN}`;
    const first = await invoicesSvc.recordPayment(financeActor, {
      amountPaisa: "150000",
      method: "CASH" as const,
      transactionRef: `P2R-REF-B-${RUN}`,
      idempotencyKey: key,
      allocations: [
        { invoiceId: inv1.id, amountPaisa: "100000" },
        { invoiceId: inv2.id, amountPaisa: "50000" },
      ],
    });
    const replay = await invoicesSvc.recordPayment(financeActor, {
      amountPaisa: "0150000",
      method: "CASH" as const,
      transactionRef: `  P2R-REF-B-${RUN}  `,
      idempotencyKey: key,
      allocations: [
        { invoiceId: inv2.id, amountPaisa: "050000" },
        { invoiceId: inv1.id, amountPaisa: "0100000" },
      ],
    });
    expect(replay.id).toBe(first.id);
    expect(await prisma.payment.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it("F-2 regression: a legacy row with requestFingerprint=NULL rejects a replay with a completely different payload", async () => {
    const legacy = await prisma.payment.create({
      data: {
        payerType: "VENDOR",
        payerVendorId: fx.vendor,
        amountPaisa: BigInt(50000),
        method: "CASH",
        status: "PAID",
        transactionRef: `P2R-LEGACY-REF-${RUN}`,
        idempotencyKey: `p2r-fp-legacy-${RUN}`,
        requestFingerprint: null,
        paidAt: new Date(),
        recordedById: fx.adminUser,
      },
    });
    const inv = await makePayableInvoice(fx.vendor, BigInt(1000000));
    // Different amount/method/ref/allocations under the legacy key.
    // The original review probe showed this silently returning the
    // legacy payment; after the F-2 fix (fingerprint derived from
    // the stored row for NULL-fingerprint rows) it must conflict,
    // create nothing, and pay nothing on the new invoice.
    await expect(
      invoicesSvc.recordPayment(financeActor, {
        amountPaisa: "99999",
        method: "BANK_TRANSFER" as const,
        transactionRef: `P2R-OTHER-REF-${RUN}`,
        idempotencyKey: `p2r-fp-legacy-${RUN}`,
        allocations: [{ invoiceId: inv.id, amountPaisa: "99999" }],
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    expect(await prisma.payment.count({ where: { idempotencyKey: `p2r-fp-legacy-${RUN}` } })).toBe(1);
    expect((await prisma.payment.findUnique({ where: { id: legacy.id } }))?.amountPaisa).toBe(BigInt(50000));
    const detail = await invoicesSvc.getInvoice(financeActor, inv.id);
    expect(BigInt(detail.paidPaisa)).toBe(BigInt(0));
  });

  it("second-writer check: paySettlement's schema carries no idempotency key at all", () => {
    expect(Object.keys(settlementsSvc.paySettlementSchema.shape).sort()).toEqual([
      "method",
      "transactionRef",
    ]);
  });
});

// ---------------------------------------------------------------------
// 2) Journal-balance trigger bypass attempts
// ---------------------------------------------------------------------

describe("journal-balance trigger", { timeout: 120_000 }, () => {
  it("control: unbalanced direct insert is rejected at commit, no rows survive", async () => {
    const account = await prisma.financialAccount.findUniqueOrThrow({ where: { code: "CASH_ON_HAND" } });
    const ref = `P2R-UNBAL-${RUN}`;
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.ledgerTransaction.create({ data: directLeg(ref, account.id, "DEBIT", BigInt(7000)) });
        await tx.ledgerTransaction.create({ data: directLeg(ref, account.id, "CREDIT", BigInt(6999)) });
      }),
    ).rejects.toThrow();
    expect(await prisma.ledgerTransaction.count({ where: { journalRef: ref } })).toBe(0);
    fx.cashAccount = account.id;
  });

  it("UPDATE bypass attempt: append-only trigger blocks rewriting a leg; sequential balanced appends still commit; a lone append is rejected", async () => {
    const ref = `P2R-SEQ-${RUN}`;
    await prisma.$transaction(async (tx) => {
      await tx.ledgerTransaction.create({ data: directLeg(ref, fx.cashAccount, "DEBIT", BigInt(10000)) });
      await tx.ledgerTransaction.create({ data: directLeg(ref, fx.cashAccount, "CREDIT", BigInt(10000)) });
    });
    const leg = await prisma.ledgerTransaction.findFirstOrThrow({
      where: { journalRef: ref, direction: "DEBIT" },
    });
    await expect(
      prisma.ledgerTransaction.update({
        where: { id: leg.id },
        data: { amountPaisa: BigInt(1) },
      }),
    ).rejects.toThrow();
    let sums = await journalSums(ref);
    expect(sums).toEqual({ debits: BigInt(10000), credits: BigInt(10000), count: 2 });

    // Legitimate whole-ref append (COD re-submit pattern): a later
    // balanced set under the same ref commits.
    await prisma.$transaction(async (tx) => {
      await tx.ledgerTransaction.create({ data: directLeg(ref, fx.cashAccount, "DEBIT", BigInt(5000)) });
      await tx.ledgerTransaction.create({ data: directLeg(ref, fx.cashAccount, "CREDIT", BigInt(5000)) });
    });
    sums = await journalSums(ref);
    expect(sums).toEqual({ debits: BigInt(15000), credits: BigInt(15000), count: 4 });

    // A lone unbalanced append to the now-balanced ref is rejected.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.ledgerTransaction.create({ data: directLeg(ref, fx.cashAccount, "DEBIT", BigInt(1)) });
      }),
    ).rejects.toThrow();
    sums = await journalSums(ref);
    expect(sums.count).toBe(4);
  });

  it("concurrent-split bypass attempt: DEBIT in tx A and CREDIT in tx B under one fresh ref — both commits are rejected", async () => {
    const ref = `P2R-SPLIT-${RUN}`;
    const oneLeg = (direction: "DEBIT" | "CREDIT") =>
      prisma.$transaction(async (tx) => {
        await tx.ledgerTransaction.create({
          data: directLeg(ref, fx.cashAccount, direction, BigInt(77700)),
        });
        await tx.$executeRaw`SELECT pg_sleep(0.5)`;
      });
    const results = await Promise.allSettled([oneLeg("DEBIT"), oneLeg("CREDIT")]);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
    expect(await prisma.ledgerTransaction.count({ where: { journalRef: ref } })).toBe(0);
  });
});

// ---------------------------------------------------------------------
// 3) Invitation limiter
// ---------------------------------------------------------------------

describe("invitation limiter", { timeout: 180_000 }, () => {
  it("header trust: getClientIp takes the FIRST x-forwarded-for entry verbatim (spoofable where no overwriting proxy sits in front)", () => {
    const headers = {
      get: (name: string) =>
        name === "x-forwarded-for" ? `${IP_VICTIM}, 10.0.0.8` : null,
    };
    expect(clientIp.getClientIp(headers)).toBe(IP_VICTIM);
  });

  it("victim-IP burn: 20 failures from the victim's IP refuse the victim's VALID token (generic message); a fresh IP succeeds", async () => {
    const invitee = email("victim");
    const created = await invitationsSvc.createInvitation(adminActor, {
      email: invitee,
      roleCode: "WAREHOUSE_STAFF",
      warehouseId: fx.whA,
    });
    for (let i = 0; i < 20; i++) {
      await expect(
        invitationsSvc.acceptInvitation(
          {
            token: `bad-token-${RUN}-${i}-0123456789abcdef0123456789`,
            fullName: "Budget Burner",
            password: "burner-password-1",
          },
          { ipAddress: IP_VICTIM },
        ),
      ).rejects.toMatchObject({ message: GENERIC });
    }
    await expect(
      invitationsSvc.acceptInvitation(
        { token: created.token, fullName: "Victim User", password: "victim-password-1" },
        { ipAddress: IP_VICTIM },
      ),
    ).rejects.toMatchObject({ message: GENERIC });
    const invitation = await prisma.userInvitation.findUnique({ where: { id: created.invitationId } });
    expect(invitation?.status).toBe("PENDING");
    expect(await prisma.user.count({ where: { email: invitee } })).toBe(0);

    const accepted = await invitationsSvc.acceptInvitation(
      { token: created.token, fullName: "Victim User", password: "victim-password-1" },
      { ipAddress: IP_FRESH },
    );
    expect(accepted.email).toBe(invitee);
  });

  it("race counting: two simultaneous accepts record EXACTLY one success and one failure (no double / missing count)", async () => {
    const invitee = email("race");
    const created = await invitationsSvc.createInvitation(adminActor, {
      email: invitee,
      roleCode: "WAREHOUSE_STAFF",
      warehouseId: fx.whA,
    });
    const results = await Promise.allSettled([
      invitationsSvc.acceptInvitation(
        { token: created.token, fullName: "Racer One", password: "racer-password-1" },
        { ipAddress: IP_RACE },
      ),
      invitationsSvc.acceptInvitation(
        { token: created.token, fullName: "Racer Two", password: "racer-password-2" },
        { ipAddress: IP_RACE },
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const tokenHash = createHash("sha256").update(created.token).digest("hex");
    expect(
      await prisma.invitationAttempt.count({
        where: { tokenHash, ipAddress: IP_RACE, succeeded: true },
      }),
    ).toBe(1);
    expect(
      await prisma.invitationAttempt.count({
        where: { tokenHash, ipAddress: IP_RACE, succeeded: false },
      }),
    ).toBe(1);
    expect(await prisma.user.count({ where: { email: invitee } })).toBe(1);
  });

  it("parse-before-check gap: malformed (short-token) attempts are never counted — and can never succeed, so the valid accept from that IP still works", async () => {
    for (let i = 0; i < 25; i++) {
      await expect(
        invitationsSvc.acceptInvitation(
          { token: "short", fullName: "Mal Formed", password: "malformed-password-1" },
          { ipAddress: IP_MALFORMED },
        ),
      ).rejects.toBeInstanceOf(errors.DomainValidationError);
    }
    // Count by this test's exact token hash: raw per-IP table counts
    // accumulate across runs (IPs come from a small octet space),
    // while the limiter itself windows on createdAt.
    const shortHash = createHash("sha256").update("short").digest("hex");
    expect(
      await prisma.invitationAttempt.count({
        where: { ipAddress: IP_MALFORMED, tokenHash: shortHash },
      }),
    ).toBe(0);
    const invitee = email("after-malformed");
    const created = await invitationsSvc.createInvitation(adminActor, {
      email: invitee,
      roleCode: "WAREHOUSE_STAFF",
      warehouseId: fx.whA,
    });
    const accepted = await invitationsSvc.acceptInvitation(
      { token: created.token, fullName: "After Malformed", password: "after-password-1" },
      { ipAddress: IP_MALFORMED },
    );
    expect(accepted.email).toBe(invitee);
  });

  it("F-4 regression: an expired token returns the generic refusal (no oracle), and the attempt is counted", async () => {
    const invitee = email("expired");
    const created = await invitationsSvc.createInvitation(adminActor, {
      email: invitee,
      roleCode: "WAREHOUSE_STAFF",
      warehouseId: fx.whA,
    });
    await prisma.userInvitation.update({
      where: { id: created.invitationId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const failure = await invitationsSvc
      .acceptInvitation(
        { token: created.token, fullName: "Expired User", password: "expired-password-1" },
        { ipAddress: IP_EXPIRED },
      )
      .then(() => null, (e: Error) => e);
    expect(failure).toBeInstanceOf(errors.DomainValidationError);
    // F-4 fixed in-phase: the expired class now refuses with the
    // same generic message as invalid/used/limiter refusals.
    expect(failure!.message).toBe(GENERIC);
    const tokenHash = createHash("sha256").update(created.token).digest("hex");
    expect(
      await prisma.invitationAttempt.count({
        where: { tokenHash, ipAddress: IP_EXPIRED, succeeded: false },
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------
// 4) Four-eyes under the FINANCE grant
// ---------------------------------------------------------------------

describe("adjustment four-eyes", { timeout: 120_000 }, () => {
  it("creator cannot self-approve (reaches the four-eyes check, not a permission error); status stays REQUESTED", async () => {
    const inv = await makePayableInvoice(fx.vendor, BigInt(500000));
    const adjustment = await adjustmentsSvc.createAdjustment(financeActor, {
      targetType: "INVOICE",
      targetId: inv.id,
      amountPaisa: "100000",
      reason: "P2R self-approve probe credit",
    });
    await expect(
      adjustmentsSvc.approveAdjustment(financeActor, adjustment.id),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    const row = await prisma.financialAdjustment.findUniqueOrThrow({ where: { id: adjustment.id } });
    expect(row.status).toBe("REQUESTED");
    fx.selfRejectAdjustment = adjustment.id;
  });

  it("observation: creator CAN self-reject their own adjustment (no four-eyes on the reject path — no money moves)", async () => {
    const rejected = await adjustmentsSvc.rejectAdjustment(financeActor, fx.selfRejectAdjustment);
    expect(rejected.status).toBe("REJECTED");
  });

  it("concurrent approve by two DIFFERENT finance users: exactly one applies, journal posts once and balanced", async () => {
    const inv = await makePayableInvoice(fx.vendor, BigInt(500000));
    const adjustment = await adjustmentsSvc.createAdjustment(financeActor, {
      targetType: "INVOICE",
      targetId: inv.id,
      amountPaisa: "120000",
      reason: "P2R concurrent approve credit",
    });
    const results = await Promise.allSettled([
      adjustmentsSvc.approveAdjustment(finance2Actor, adjustment.id),
      adjustmentsSvc.approveAdjustment(finance3Actor, adjustment.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(errors.ConflictError);
    const row = await prisma.financialAdjustment.findUniqueOrThrow({ where: { id: adjustment.id } });
    expect(row.status).toBe("APPLIED");
    const sums = await journalSums(`ADJ-${adjustment.id}`);
    expect(sums).toEqual({ debits: BigInt(120000), credits: BigInt(120000), count: 2 });
    // A third approval attempt after application conflicts cleanly.
    await expect(
      adjustmentsSvc.approveAdjustment(finance2Actor, adjustment.id),
    ).rejects.toBeInstanceOf(errors.ConflictError);
  });
});

// ---------------------------------------------------------------------
// 5) L-2 movement-touch scope
// ---------------------------------------------------------------------

describe("L-2 listPackageMovements", { timeout: 120_000 }, () => {
  it("scoped reader gets the FULL history once any movement touches their warehouse; SUPPORT (unscoped, no memberships) still reads; membership-less RIDER is denied", async () => {
    const booking = await bookingsSvc.createBooking(adminActor, {
      vendorId: fx.vendor,
      sender: { name: "P2R Sender", phone: phone(42), email: null },
      recipient: {
        name: "P2R Recipient",
        phone: phone(101),
        addressLine: "Some Street 1",
        city: "Town",
        district: fx.districtB,
        province: "Bagmati",
      },
      pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId: fx.whA },
      shippingServiceCode: serviceCode,
      paymentMethod: "CASH" as const,
      codAmountPaisa: "0",
      items: [{ description: "Parcel", quantity: 1, weightKg: 1.0 }],
    });
    const pkg = booking.shipments[0].packages[0];
    await inventorySvc.receivePackage(staffAActor, { warehouseId: fx.whA, trackingId: pkg.trackingId });
    // Force the L-2 state: no open record, no current warehouse.
    await prisma.inventoryRecord.updateMany({
      where: { packageId: pkg.id, releasedAt: null },
      data: { releasedAt: new Date(), releasedById: fx.staffA, releaseReason: "CORRECTION" },
    });
    await prisma.package.update({ where: { id: pkg.id }, data: { currentWarehouseId: null } });

    // Membership-less RIDER holds custody.read but no warehouse at
    // all: the touch check has nothing to match — denied.
    expect(riderActor.warehouseIds).toEqual([]);
    await expect(
      inventorySvc.listPackageMovements(riderActor, pkg.id),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    // SUPPORT holds custody.read + warehouse.read_all and NO
    // memberships: unscoped, so the L-2 branch must not deny them.
    expect(supportActor.warehouseIds).toEqual([]);
    const supportRows = await inventorySvc.listPackageMovements(supportActor, pkg.id);
    expect(supportRows.length).toBeGreaterThanOrEqual(1);

    // Warehouse A reads its own touching history.
    const beforeRows = await inventorySvc.listPackageMovements(waAActor, pkg.id);
    expect(beforeRows.length).toBe(supportRows.length);
    expect(beforeRows.some((m) => m.toWarehouseCode === "WH-QR2-02")).toBe(false);

    // Add a movement that touches BOTH A (from) and B (to), cloned
    // from the real receiving movement's type.
    const seedMovement = await prisma.inventoryMovement.findFirstOrThrow({
      where: { packageId: pkg.id },
    });
    await prisma.inventoryMovement.create({
      data: {
        packageId: pkg.id,
        type: seedMovement.type,
        fromWarehouseId: fx.whA,
        toWarehouseId: fx.whB,
        actorId: fx.waA,
        reason: "P2R cross-warehouse history row",
      },
    });
    // A's scoped reader now receives B's side of the history too —
    // warehouse codes, location codes, actor names and reasons for
    // a warehouse outside their scope.
    const afterRows = await inventorySvc.listPackageMovements(waAActor, pkg.id);
    expect(afterRows.length).toBe(beforeRows.length + 1);
    expect(afterRows.some((m) => m.toWarehouseCode === "WH-QR2-02")).toBe(true);
  });
});

// ---------------------------------------------------------------------
// 6) CUSTOMER notification.read_own isolation
// ---------------------------------------------------------------------

describe("customer notifications", { timeout: 120_000 }, () => {
  it("customer sees ONLY their own IN_APP rows — never the userId-NULL TRACKING/OTP row, never another user's row; mark-all and preferences stay own-scoped", async () => {
    const otpCode = `P2R-OTP-${RUN_NUM}`;
    const own = await prisma.notification.create({
      data: {
        userId: fx.customerUser,
        category: "GENERAL",
        channel: "IN_APP",
        deliveryStatus: "SENT",
        title: "P2R own notice",
        body: "Your parcel update",
        dedupeKey: `p2r-own-${RUN}`,
      },
    });
    const other = await prisma.notification.create({
      data: {
        userId: fx.financeUser,
        category: "GENERAL",
        channel: "IN_APP",
        deliveryStatus: "SENT",
        title: "P2R finance notice",
        body: "Finance only",
        dedupeKey: `p2r-other-${RUN}`,
      },
    });
    const tracking = await prisma.notification.create({
      data: {
        userId: null,
        recipientPhone: phone(101),
        recipientCustomerId: fx.customerProfile,
        category: "DELIVERY_OTP",
        channel: "TRACKING",
        deliveryStatus: "AVAILABLE",
        title: "Delivery code",
        body: "Your delivery code",
        payload: { otpCode },
        dedupeKey: `p2r-tracking-${RUN}`,
      },
    });

    const list = await notificationsSvc.listMyNotifications(customerActor, { pageSize: 100 });
    expect(list.items.map((i) => i.id)).toEqual([own.id]);
    expect(JSON.stringify(list)).not.toContain(otpCode);
    expect(list.unreadCount).toBe(1);
    const otpFiltered = await notificationsSvc.listMyNotifications(customerActor, {
      pageSize: 100,
      category: "DELIVERY_OTP" as never,
    });
    expect(otpFiltered.items).toHaveLength(0);
    expect((await notificationsSvc.getMyUnreadCount(customerActor)).count).toBe(1);

    await expect(
      notificationsSvc.markNotificationRead(customerActor, tracking.id),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      notificationsSvc.markNotificationRead(customerActor, other.id),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    const marked = await notificationsSvc.markAllMyNotificationsRead(customerActor);
    expect(marked.marked).toBe(1);
    const otherAfter = await prisma.notification.findUniqueOrThrow({ where: { id: other.id } });
    const trackingAfter = await prisma.notification.findUniqueOrThrow({ where: { id: tracking.id } });
    expect(otherAfter.readAt).toBeNull();
    expect(trackingAfter.readAt).toBeNull();

    const pref = await notificationsSvc.updateMyNotificationPreference(customerActor, {
      category: "GENERAL",
      channel: "EMAIL",
      enabled: false,
    });
    expect(pref.enabled).toBe(false);
    expect(
      await prisma.notificationPreference.count({ where: { userId: fx.financeUser } }),
    ).toBe(0);
    const customerPrefs = await notificationsSvc.getMyNotificationPreferences(customerActor);
    expect(
      customerPrefs.find((p) => p.category === "GENERAL" && p.channel === "EMAIL")?.enabled,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------
// 7) Deleted staff routes / direct service calls
// ---------------------------------------------------------------------

describe("deleted staff create routes", { timeout: 120_000 }, () => {
  it("staff page files are gone, warehouse variants remain", () => {
    const appRoot = join(process.cwd(), "src/app/(dashboards)");
    expect(existsSync(join(appRoot, "staff/transfers/new/page.tsx"))).toBe(false);
    expect(existsSync(join(appRoot, "staff/deliveries/new/page.tsx"))).toBe(false);
    expect(existsSync(join(appRoot, "warehouse/transfers/new/page.tsx"))).toBe(true);
    expect(existsSync(join(appRoot, "warehouse/deliveries/new/page.tsx"))).toBe(true);
  });

  it("a WAREHOUSE_STAFF actor calling the create services directly is denied cleanly; a warehouse admin control succeeds", async () => {
    await expect(
      transfersSvc.createTransfer(staffAActor, {
        originWarehouseId: fx.whA,
        destinationWarehouseId: fx.whB,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      deliveriesSvc.createDeliveryBatch(staffAActor, {
        warehouseId: fx.whA,
        riderUserId: fx.riderUser,
        batchDate: new Date().toISOString().slice(0, 10),
        kind: "DELIVERY",
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const control = await transfersSvc.createTransfer(waAActor, {
      originWarehouseId: fx.whA,
      destinationWarehouseId: fx.whB,
    });
    expect(control.id).toBeTruthy();
    expect(waBActor.userId).toBeTruthy();
  });
});
