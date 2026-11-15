import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hash } from "bcryptjs";
import type { PrismaClient } from "@prisma/client";

// Phase 10 production gates (slice 1): F8 session idle timeout, F13
// TOTP MFA for SUPER_ADMIN/ADMIN, and the per-IP public-tracking
// failure budget (P3-2 / P6-R6 remainder). Same preamble discipline
// as the other integration suites: bla_dev URL rewritten to bla_test
// in the PATH only, per-run unique emails AND IPs (append-only audit
// and attempt rows persist in the disposable test database).

vi.mock("server-only", () => ({}));

function readEnvVar(name: string): string {
  for (const file of [".env.local", "prisma/.env"]) {
    try {
      const text = readFileSync(path.resolve(process.cwd(), file), "utf8");
      const match = text.match(new RegExp(`^${name}=(.+)$`, "m"));
      if (match) return match[1].trim().replace(/^["']|["']$/g, "");
    } catch {
      // try the next file
    }
  }
  throw new Error(`${name} not found in .env.local or prisma/.env`);
}

const devUrl = readEnvVar("DATABASE_URL");
if (new URL(devUrl).pathname !== "/bla_dev") {
  throw new Error("Integration tests require DATABASE_URL to target bla_dev.");
}
const marker = "/bla_dev";
const idx = devUrl.lastIndexOf(marker);
process.env.DATABASE_URL =
  devUrl.slice(0, idx) + "/bla_test" + devUrl.slice(idx + marker.length);
process.env.MFA_SECRET_ENCRYPTION_KEY = readEnvVar("MFA_SECRET_ENCRYPTION_KEY");

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const email = (label: string) => `p10-${label}-${RUN}@test.local`;
const testIp = (host: number) => `198.51.${1 + Math.floor(Math.random() * 250)}.${host}`;
const PASSWORD = "Phase10#Gate2026";
const HOUR = 60 * 60 * 1000;

let prisma: PrismaClient;
let verifyCredentials: typeof import("@/server/services/authentication").verifyCredentials;
let applySessionPolicy: typeof import("@/lib/auth/session-enforcement").applySessionPolicy;
let mfaSvc: typeof import("@/server/services/mfa");
let usersSvc: typeof import("@/server/services/users");
let packagesSvc: typeof import("@/server/services/packages");
let ticketsSvc: typeof import("@/server/services/support-tickets");
let trackingAccess: typeof import("@/server/services/tracking-access");
let totpLib: typeof import("@/lib/auth/totp");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let domain: typeof import("@/lib/deliveries/domain");
let trackingLib: typeof import("@/lib/bookings/tracking");

const fx = {
  saUser: "",
  adminUser: "",
  admin2User: "",
  staffUser: "",
  secret: "",
  realTrackingId: "",
};
const RECIPIENT_PHONE = "9812345678";

async function makeUser(label: string, roleCode: string): Promise<string> {
  const passwordHash = await hash(PASSWORD, 12);
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: `P10 ${label}`,
      passwordHash,
      status: "ACTIVE",
      mustChangePassword: false,
    },
  });
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  if (!role) throw new Error(`role ${roleCode} missing`);
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user.id;
}

async function actorFor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
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
  const catalog = await import("@/lib/permissions/catalog");
  return {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    roles: roles as never[],
    primaryRole: catalog.primaryRoleFor(roles as never[]),
    permissions,
    warehouseIds: [] as string[],
    membershipRoles: [] as never[],
    vendorId: null,
    vendorRole: null,
    driverId: null,
    customerId: null,
    landingPath: "/",
  };
}

async function makeSession(
  userId: string,
  lastActivityAt: Date,
): Promise<{ id: string; sessionToken: string }> {
  const sessionToken = `p10-${RUN}-${randomBytes(12).toString("hex")}`;
  const row = await prisma.session.create({
    data: {
      sessionToken,
      userId,
      expires: new Date(Date.now() + 30 * 24 * HOUR),
      lastActivityAt,
    },
  });
  return { id: row.id, sessionToken };
}

function wrongCodeFor(secret: string): string {
  const now = new Date();
  const counter = totpLib.totpCounter(now);
  const valid = new Set([
    totpLib.hotp(secret, counter - 1),
    totpLib.hotp(secret, counter),
    totpLib.hotp(secret, counter + 1),
  ]);
  for (const candidate of ["000000", "111111", "222222", "999999", "123456"]) {
    if (!valid.has(candidate)) return candidate;
  }
  throw new Error("unreachable");
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/db/prisma"));
  ({ verifyCredentials } = await import("@/server/services/authentication"));
  ({ applySessionPolicy } = await import("@/lib/auth/session-enforcement"));
  mfaSvc = await import("@/server/services/mfa");
  usersSvc = await import("@/server/services/users");
  packagesSvc = await import("@/server/services/packages");
  ticketsSvc = await import("@/server/services/support-tickets");
  trackingAccess = await import("@/server/services/tracking-access");
  totpLib = await import("@/lib/auth/totp");
  errors = await import("@/lib/errors");
  actorErrors = await import("@/lib/auth/actor");
  domain = await import("@/lib/deliveries/domain");
  trackingLib = await import("@/lib/bookings/tracking");

  // Permission catalog into bla_test (same upserts as the seed).
  const catalog = await import("@/lib/permissions/catalog");
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

  fx.saUser = await makeUser("sa", "SUPER_ADMIN");
  fx.adminUser = await makeUser("admin", "ADMIN");
  fx.admin2User = await makeUser("admin2", "ADMIN");
  fx.staffUser = await makeUser("staff", "WAREHOUSE_STAFF");

  // A real package (direct rows — the tracking services read the
  // package + shipment origin only) for the legitimate-success case.
  const warehouse = await prisma.warehouse.create({
    data: {
      code: `WH-P10-${RUN.slice(0, 8)}`,
      name: "P10 Fixture Warehouse",
      district: "Kathmandu",
      city: "Kathmandu",
      province: "Bagmati",
      status: "ACTIVE",
    },
  });
  const service = await prisma.shippingService.create({
    data: { code: `SVC-P10-${RUN.slice(0, 8)}`, name: "P10 Standard" },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-P10-${RUN}`,
      createdById: fx.staffUser,
      createdByRole: "WAREHOUSE_STAFF",
      senderName: "P10 Sender",
      senderPhone: "9800000000",
      destinationDistrict: "Kathmandu",
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  const shipment = await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-P10-${RUN}`,
      orderId: order.id,
      originWarehouseId: warehouse.id,
      routeKind: "LAST_MILE",
      shippingServiceId: service.id,
      shippingChargePaisa: BigInt(15000),
    },
  });
  fx.realTrackingId = trackingLib.generateTrackingId();
  await prisma.package.create({
    data: {
      trackingId: fx.realTrackingId,
      shipmentId: shipment.id,
      orderId: order.id,
      recipientName: "P10 Recipient",
      recipientPhone: RECIPIENT_PHONE,
      deliveryAddress: "Thamel Street 1",
      deliveryCity: "Kathmandu",
      deliveryDistrict: "Kathmandu",
      declaredWeightKg: 1.0,
      description: "P10 parcel",
    },
  });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("F8 — session idle timeout", () => {
  it("a privileged session idle 13h is expired and deleted; a staff session at the same age survives", async () => {
    const idleSince = new Date(Date.now() - 13 * HOUR);
    const adminSession = await makeSession(fx.adminUser, idleSince);
    const outcome = await applySessionPolicy(
      adminSession.sessionToken,
      fx.adminUser,
      ["ADMIN"],
      false,
    );
    expect(outcome.expired).toBe(true);
    expect(
      await prisma.session.findUnique({ where: { id: adminSession.id } }),
    ).toBeNull();

    const staffSession = await makeSession(fx.staffUser, idleSince);
    const staffOutcome = await applySessionPolicy(
      staffSession.sessionToken,
      fx.staffUser,
      ["WAREHOUSE_STAFF"],
      false,
    );
    expect(staffOutcome.expired).toBe(false);
    const staffRow = await prisma.session.findUnique({ where: { id: staffSession.id } });
    expect(staffRow).not.toBeNull();
    // Activity was re-stamped (the touch) — the idle clock reset.
    expect(staffRow!.lastActivityAt.getTime()).toBeGreaterThan(idleSince.getTime());
  });

  it("a privileged session idle 11h passes; a staff session idle 25h expires (24h staff limit)", async () => {
    const fresh = await makeSession(fx.adminUser, new Date(Date.now() - 11 * HOUR));
    expect(
      (await applySessionPolicy(fresh.sessionToken, fx.adminUser, ["ADMIN"], false)).expired,
    ).toBe(false);

    const stale = await makeSession(fx.staffUser, new Date(Date.now() - 25 * HOUR));
    expect(
      (await applySessionPolicy(stale.sessionToken, fx.staffUser, ["WAREHOUSE_STAFF"], false))
        .expired,
    ).toBe(true);
  });

  it("the touch is throttled: a session active 2 minutes ago is not re-stamped", async () => {
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
    const session = await makeSession(fx.staffUser, twoMinAgo);
    await applySessionPolicy(session.sessionToken, fx.staffUser, ["WAREHOUSE_STAFF"], false);
    const row = await prisma.session.findUnique({ where: { id: session.id } });
    expect(row!.lastActivityAt.getTime()).toBe(twoMinAgo.getTime());
  });
});

describe("F13 — TOTP MFA for privileged roles", () => {
  it("a fresh admin's password login reports enrolment-required; a staff login is unchanged", async () => {
    const adminLogin = await verifyCredentials(email("admin"), PASSWORD, {
      ipAddress: testIp(11),
      userAgent: "phase10-test",
    });
    expect(adminLogin?.mfaEnrolmentRequired).toBe(true);
    expect(adminLogin?.mfaChallengeRequired).toBe(false);

    const staffLogin = await verifyCredentials(email("staff"), PASSWORD, {
      ipAddress: testIp(12),
      userAgent: "phase10-test",
    });
    expect(staffLogin?.mfaEnrolmentRequired).toBe(false);
    expect(staffLogin?.mfaChallengeRequired).toBe(false);
  });

  it("enrolment is idempotent, activates only on a valid code, and stamps the enrolling session", async () => {
    const adminActor = await actorFor(fx.adminUser);
    const first = await mfaSvc.beginMfaEnrolment(adminActor as never);
    fx.secret = first.secretBase32;
    const second = await mfaSvc.beginMfaEnrolment(adminActor as never);
    expect(second.secretBase32).toBe(fx.secret);
    expect(first.otpauthUrl).toContain("otpauth://totp/");

    const session = await makeSession(fx.adminUser, new Date());
    await expect(
      mfaSvc.confirmMfaEnrolment(adminActor as never, wrongCodeFor(fx.secret), session.sessionToken),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    let user = await prisma.user.findUnique({ where: { id: fx.adminUser } });
    expect(user!.mfaEnabled).toBe(false);

    await mfaSvc.confirmMfaEnrolment(
      adminActor as never,
      totpLib.totp(fx.secret),
      session.sessionToken,
    );
    user = await prisma.user.findUnique({ where: { id: fx.adminUser } });
    expect(user!.mfaEnabled).toBe(true);
    expect(user!.mfaLastUsedCounter).not.toBeNull();
    const stamped = await prisma.session.findUnique({ where: { id: session.id } });
    expect(stamped!.mfaVerifiedAt).not.toBeNull();

    // Enrolled now: begin is refused, and password login requires the challenge.
    await expect(mfaSvc.beginMfaEnrolment(adminActor as never)).rejects.toBeInstanceOf(
      errors.DomainValidationError,
    );
    const login = await verifyCredentials(email("admin"), PASSWORD, {
      ipAddress: testIp(13),
      userAgent: "phase10-test",
    });
    expect(login?.mfaChallengeRequired).toBe(true);
    expect(login?.mfaEnrolmentRequired).toBe(false);
  });

  it("an enrolled admin's session is MFA-pending until the challenge stamps it", async () => {
    const session = await makeSession(fx.adminUser, new Date());
    const outcome = await applySessionPolicy(
      session.sessionToken,
      fx.adminUser,
      ["ADMIN"],
      true,
    );
    expect(outcome).toEqual({ expired: false, mfaPending: true });
  });

  it("challenge: wrong codes are recorded, the 5th failure destroys the session and locks the user window; on a fresh user, replay is rejected and the next counter succeeds", async () => {
    const wrong = wrongCodeFor(fx.secret);

    const doomed = await makeSession(fx.adminUser, new Date());
    for (let i = 0; i < 4; i++) {
      const res = await mfaSvc.verifyMfaChallenge(doomed.sessionToken, wrong, {
        ipAddress: testIp(21),
        userAgent: "phase10-test",
      });
      expect(res).toEqual({ ok: false, locked: false });
    }
    expect(
      await prisma.session.findUnique({ where: { id: doomed.id } }),
    ).not.toBeNull();
    const fifth = await mfaSvc.verifyMfaChallenge(doomed.sessionToken, wrong, {
      ipAddress: testIp(21),
      userAgent: "phase10-test",
    });
    expect(fifth).toEqual({ ok: false, locked: true });
    expect(await prisma.session.findUnique({ where: { id: doomed.id } })).toBeNull();
    const failedAttempts = await prisma.loginAttempt.count({
      where: { userId: fx.adminUser, reason: "mfa_failed", success: false },
    });
    expect(failedAttempts).toBe(5);
    const lockAudit = await prisma.auditLog.findFirst({
      where: { action: "auth.mfa_challenge_locked", entityId: fx.adminUser },
    });
    expect(lockAudit).not.toBeNull();

    // The budget is per USER (mirrors the login lockout): while the
    // 15-minute window is saturated, even a brand-new session is
    // refused at entry and destroyed.
    const blocked = await makeSession(fx.adminUser, new Date());
    const blockedRes = await mfaSvc.verifyMfaChallenge(blocked.sessionToken, wrong, {
      ipAddress: testIp(21),
      userAgent: "phase10-test",
    });
    expect(blockedRes).toEqual({ ok: false, locked: true });
    expect(await prisma.session.findUnique({ where: { id: blocked.id } })).toBeNull();

    // Replay + success run against the second admin, whose failure
    // window is clean: enrol her first.
    const admin2Actor = await actorFor(fx.admin2User);
    const enrolment2 = await mfaSvc.beginMfaEnrolment(admin2Actor as never);
    await mfaSvc.confirmMfaEnrolment(admin2Actor as never, totpLib.totp(enrolment2.secretBase32));
    const admin2 = await prisma.user.findUnique({ where: { id: fx.admin2User } });
    const watermark2 = admin2!.mfaLastUsedCounter!;

    // Replay: the code consumed at enrolment (counter == watermark)
    // must never work again.
    const session = await makeSession(fx.admin2User, new Date());
    const replay = await mfaSvc.verifyMfaChallenge(
      session.sessionToken,
      totpLib.hotp(enrolment2.secretBase32, watermark2),
      { ipAddress: testIp(22), userAgent: "phase10-test" },
    );
    expect(replay.ok).toBe(false);

    // The next counter is inside the ±1 window and succeeds.
    const ok = await mfaSvc.verifyMfaChallenge(
      session.sessionToken,
      totpLib.hotp(enrolment2.secretBase32, watermark2 + 1),
      { ipAddress: testIp(22), userAgent: "phase10-test" },
    );
    // The service's success shape is { ok: true } — `locked` exists
    // only on the failure branch of the result union.
    expect(ok.ok).toBe(true);
    const stamped = await prisma.session.findUnique({ where: { id: session.id } });
    expect(stamped!.mfaVerifiedAt).not.toBeNull();
    const after = await applySessionPolicy(session.sessionToken, fx.admin2User, ["ADMIN"], true);
    expect(after.mfaPending).toBe(false);
  });

  it("reset by another super admin restores the enrolment-required state and kills sessions; non-super-admin and self resets are refused", async () => {
    const saActor = await actorFor(fx.saUser);
    const admin2Actor = await actorFor(fx.admin2User);

    await expect(
      usersSvc.resetUserMfa(admin2Actor as never, fx.adminUser),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(usersSvc.resetUserMfa(saActor as never, fx.saUser)).rejects.toBeInstanceOf(
      errors.DomainValidationError,
    );

    await usersSvc.resetUserMfa(saActor as never, fx.adminUser);
    const user = await prisma.user.findUnique({ where: { id: fx.adminUser } });
    expect(user!.mfaEnabled).toBe(false);
    expect(user!.mfaSecretEncrypted).toBeNull();
    expect(user!.mfaLastUsedCounter).toBeNull();
    expect(await prisma.session.count({ where: { userId: fx.adminUser } })).toBe(0);
    const audit = await prisma.auditLog.findFirst({
      where: { action: "user.mfa_reset", entityId: fx.adminUser },
    });
    expect(audit).not.toBeNull();

    const login = await verifyCredentials(email("admin"), PASSWORD, {
      ipAddress: testIp(14),
      userAgent: "phase10-test",
    });
    expect(login?.mfaEnrolmentRequired).toBe(true);
    expect(login?.mfaChallengeRequired).toBe(false);
  });
});

describe("per-IP public tracking budget (P3-2 / P6-R6 remainder)", () => {
  const ipA = testIp(31);
  const ipB = testIp(32);
  const ipC = testIp(33);

  it("one IP failing across many distinct ids is cut off at the budget; rows stop growing; other IPs and successes are unaffected", async () => {
    const limit = domain.TRACKING_IP_FAILURE_LIMIT;
    for (let i = 0; i < limit; i++) {
      await expect(
        packagesSvc.getDetailedTracking(trackingLib.generateTrackingId(), "9800000000", {
          ipAddress: ipA,
        }),
      ).rejects.toBeInstanceOf(errors.NotFoundError);
    }
    const countFor = () =>
      prisma.trackingAccessAttempt.count({
        where: { ipAddress: ipA, succeeded: false },
      });
    expect(await countFor()).toBe(limit);
    expect(await trackingAccess.isTrackingIpBudgetExceeded(ipA)).toBe(true);

    // The 61st detailed attempt, a basic lookup, and a complaint from
    // the exhausted IP all get the same indistinguishable denial and
    // write NOTHING (the budget decays with its window).
    await expect(
      packagesSvc.getDetailedTracking(trackingLib.generateTrackingId(), "9800000000", {
        ipAddress: ipA,
      }),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
    await expect(
      packagesSvc.getPublicTracking(trackingLib.generateTrackingId(), { ipAddress: ipA }),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
    await expect(
      ticketsSvc.raiseTrackingComplaint(
        fx.realTrackingId,
        {
          phone: RECIPIENT_PHONE,
          category: "GENERAL",
          subject: "Where is my parcel",
          description: "Phase 10 budget test complaint.",
        },
        { ipAddress: ipA },
      ),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
    expect(await countFor()).toBe(limit);

    // A different IP is unaffected: its failure is recorded (it
    // reached the service, not the limiter).
    await expect(
      packagesSvc.getDetailedTracking(trackingLib.generateTrackingId(), "9800000000", {
        ipAddress: ipB,
      }),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
    expect(
      await prisma.trackingAccessAttempt.count({
        where: { ipAddress: ipB, succeeded: false },
      }),
    ).toBe(1);
    expect(await trackingAccess.isTrackingIpBudgetExceeded(ipB)).toBe(false);

    // Successes never consume the budget.
    for (let i = 0; i < limit + 10; i++) {
      await prisma.trackingAccessAttempt.create({
        data: {
          trackingId: trackingLib.generateTrackingId(),
          phoneHash: "x",
          succeeded: true,
          ipAddress: ipC,
        },
      });
    }
    expect(await trackingAccess.isTrackingIpBudgetExceeded(ipC)).toBe(false);

    // Legitimate use from the unaffected IP still works end to end:
    // detailed view with the recipient phone, and a complaint.
    const view = await packagesSvc.getDetailedTracking(fx.realTrackingId, RECIPIENT_PHONE, {
      ipAddress: ipB,
    });
    expect(view.trackingId).toBe(fx.realTrackingId);
    const complaint = await ticketsSvc.raiseTrackingComplaint(
      fx.realTrackingId,
      {
        phone: RECIPIENT_PHONE,
        category: "GENERAL",
        subject: "Please check my parcel",
        description: "Phase 10 legitimate complaint.",
      },
      { ipAddress: ipB },
    );
    expect(complaint.ticketNumber).toMatch(/^TKT-/);
  });
});
