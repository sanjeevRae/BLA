import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hash } from "bcryptjs";
import type { Prisma, PrismaClient } from "@prisma/client";

// Phase 10 slice-1 SECURITY REVIEW PoC suite (reviewer-kept artifact).
// Assertions encode the SECURE expectation, mirroring the Phase 8/9
// review suites: controls pass on current code; finding tests fail
// until the fix batch lands. Same preamble discipline as the other
// integration suites: bla_dev URL rewritten to bla_test in the PATH
// only, per-run unique emails AND IPs.

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
const email = (label: string) => `p10rev-${label}-${RUN}@test.local`;
const testIp = (host: number) => `203.0.${1 + Math.floor(Math.random() * 250)}.${host}`;
const PASSWORD = "Phase10#Review2026";
const HOUR = 60 * 60 * 1000;

let prisma: PrismaClient;
let mfaSvc: typeof import("@/server/services/mfa");
let packagesSvc: typeof import("@/server/services/packages");
let ticketsSvc: typeof import("@/server/services/support-tickets");
let settingsSvc: typeof import("@/server/services/system-settings");
let totpLib: typeof import("@/lib/auth/totp");
let errors: typeof import("@/lib/errors");
let actorLib: typeof import("@/lib/auth/actor");
let clientIpLib: typeof import("@/lib/auth/client-ip");
let enforcement: typeof import("@/lib/auth/session-enforcement");
let trackingLib: typeof import("@/lib/bookings/tracking");

const fx = {
  budgetAdmin: "",
  raceAdmin: "",
  raceSecret: "",
  victimAdmin: "",
  victimSecret: "",
  attackerAdmin: "",
  beginRaceAdmin: "",
  idleAdmin: "",
  idleSecret: "",
  realTrackingId: "",
};
const RECIPIENT_PHONE = "9812345678";

async function makeUser(label: string, roleCode: string): Promise<string> {
  const passwordHash = await hash(PASSWORD, 12);
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: `P10REV ${label}`,
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
  const sessionToken = `p10rev-${RUN}-${randomBytes(12).toString("hex")}`;
  const row = await prisma.session.create({
    data: {
      sessionToken,
      userId,
      expires: new Date(Date.now() + 7 * 24 * HOUR),
      lastActivityAt,
    },
  });
  return { id: row.id, sessionToken };
}

function wrongCodeFor(secret: string): string {
  const counter = totpLib.totpCounter(new Date());
  const valid = new Set([
    totpLib.hotp(secret, counter - 1),
    totpLib.hotp(secret, counter),
    totpLib.hotp(secret, counter + 1),
  ]);
  for (const candidate of ["000000", "111111", "222222", "999999", "123456", "654321"]) {
    if (!valid.has(candidate)) return candidate;
  }
  throw new Error("unreachable");
}

/** A code whose counter is inside the ±1 window and strictly above
 *  the user's current replay watermark. */
async function freshCodeAboveWatermark(userId: string, secret: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const watermark = user!.mfaLastUsedCounter ?? -1;
  const current = totpLib.totpCounter(new Date());
  for (const counter of [current + 1, current, current - 1]) {
    if (counter > watermark) return totpLib.hotp(secret, counter);
  }
  throw new Error("no fresh counter available in window");
}

async function enrol(userId: string): Promise<string> {
  const actor = await actorFor(userId);
  const start = await mfaSvc.beginMfaEnrolment(actor as never);
  await mfaSvc.confirmMfaEnrolment(actor as never, totpLib.totp(start.secretBase32));
  return start.secretBase32;
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/db/prisma"));
  mfaSvc = await import("@/server/services/mfa");
  packagesSvc = await import("@/server/services/packages");
  ticketsSvc = await import("@/server/services/support-tickets");
  settingsSvc = await import("@/server/services/system-settings");
  totpLib = await import("@/lib/auth/totp");
  errors = await import("@/lib/errors");
  actorLib = await import("@/lib/auth/actor");
  clientIpLib = await import("@/lib/auth/client-ip");
  enforcement = await import("@/lib/auth/session-enforcement");
  trackingLib = await import("@/lib/bookings/tracking");

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

  fx.budgetAdmin = await makeUser("budget", "ADMIN");
  fx.raceAdmin = await makeUser("race", "ADMIN");
  fx.victimAdmin = await makeUser("victim", "ADMIN");
  fx.attackerAdmin = await makeUser("attacker", "ADMIN");
  fx.beginRaceAdmin = await makeUser("beginrace", "ADMIN");
  fx.idleAdmin = await makeUser("idle", "ADMIN");
  fx.idleSecret = await enrol(fx.idleAdmin);

  // A real package for the complaint-lockout regression control.
  const staffUser = await makeUser("staff", "WAREHOUSE_STAFF");
  const warehouse = await prisma.warehouse.create({
    data: {
      code: `WH-R10-${RUN.slice(0, 8)}`,
      name: "P10REV Fixture Warehouse",
      district: "Kathmandu",
      city: "Kathmandu",
      province: "Bagmati",
      status: "ACTIVE",
    },
  });
  const service = await prisma.shippingService.create({
    data: { code: `SVC-R10-${RUN.slice(0, 8)}`, name: "P10REV Standard" },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-R10-${RUN}`,
      createdById: staffUser,
      createdByRole: "WAREHOUSE_STAFF",
      senderName: "P10REV Sender",
      senderPhone: "9800000000",
      destinationDistrict: "Kathmandu",
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  const shipment = await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-R10-${RUN}`,
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
      recipientName: "P10REV Recipient",
      recipientPhone: RECIPIENT_PHONE,
      deliveryAddress: "Thamel Street 1",
      deliveryCity: "Kathmandu",
      deliveryDistrict: "Kathmandu",
      declaredWeightKg: 1.0,
      description: "P10REV parcel",
    },
  });
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("P10-R1 — MFA challenge failure budget under concurrency (P6-R2 class)", () => {
  it("16 concurrent wrong codes: at most 5 are evaluated before the lockout destroys the session", async () => {
    const secret = await enrol(fx.budgetAdmin);
    const session = await makeSession(fx.budgetAdmin, new Date());
    const wrong = wrongCodeFor(secret);
    const meta = { ipAddress: testIp(41), userAgent: "phase10-review" };

    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        mfaSvc.verifyMfaChallenge(session.sessionToken, wrong, meta),
      ),
    );

    const failureRows = await prisma.loginAttempt.count({
      where: { userId: fx.budgetAdmin, reason: "mfa_failed", success: false },
    });
    const sessionRow = await prisma.session.findUnique({ where: { id: session.id } });

    // SECURE expectation: the 5-failure budget is atomic — no more
    // than 5 guesses are ever evaluated/recorded per window and the
    // 5th destroys the pending session (the sequential behaviour the
    // builder's suite proves). On current code the count is read
    // outside any lock/transaction, so the whole concurrent batch is
    // evaluated against a stale count: 16 rows land and the session
    // survives the batch.
    expect(failureRows).toBeLessThanOrEqual(5);
    expect(sessionRow).toBeNull();
    expect(results.filter((r) => r.ok)).toHaveLength(0);
  }, 60_000);
});

describe("P10-R2 — TOTP replay across concurrent sessions (watermark race)", () => {
  it("one code satisfies at most one pending session when submitted concurrently", async () => {
    fx.raceSecret = await enrol(fx.raceAdmin);
    const sessions = await Promise.all([
      makeSession(fx.raceAdmin, new Date()),
      makeSession(fx.raceAdmin, new Date()),
      makeSession(fx.raceAdmin, new Date()),
      makeSession(fx.raceAdmin, new Date()),
    ]);
    const code = await freshCodeAboveWatermark(fx.raceAdmin, fx.raceSecret);
    const meta = { ipAddress: testIp(42), userAgent: "phase10-review" };

    const results = await Promise.all(
      sessions.map((s) => mfaSvc.verifyMfaChallenge(s.sessionToken, code, meta)),
    );
    const successes = results.filter((r) => r.ok).length;

    // SECURE expectation: the mfaLastUsedCounter watermark makes a
    // code single-use — exactly one session may be stamped. On
    // current code every concurrent caller reads the pre-commit
    // watermark, so the same code stamps several sessions.
    expect(successes).toBe(1);

    // Sequential control (expected to hold either way): the same
    // code on a fresh session afterwards is a replay and fails.
    const fifth = await makeSession(fx.raceAdmin, new Date());
    const replay = await mfaSvc.verifyMfaChallenge(fifth.sessionToken, code, meta);
    expect(replay.ok).toBe(false);
  }, 60_000);
});

describe("P10-R3 — begin-enrolment idempotency under concurrency", () => {
  it("two concurrent begins return the SAME secret (no rotation race)", async () => {
    const actor = await actorFor(fx.beginRaceAdmin);
    const [a, b] = await Promise.all([
      mfaSvc.beginMfaEnrolment(actor as never),
      mfaSvc.beginMfaEnrolment(actor as never),
    ]);
    // SECURE expectation: idempotent begin — both callers (e.g. a
    // double-render / double-submit of the setup page) see the one
    // stored secret. On current code both observe "no secret", each
    // generates its own, and last-write-wins strands one QR code.
    expect(b.secretBase32).toBe(a.secretBase32);
    const user = await prisma.user.findUnique({ where: { id: fx.beginRaceAdmin } });
    expect(user!.mfaSecretEncrypted).not.toBeNull();
  }, 60_000);
});

describe("P10-R4 — the challenge path applies no idle policy", () => {
  it("a session idle past the privileged limit cannot complete the MFA challenge", async () => {
    const stale = await makeSession(fx.idleAdmin, new Date(Date.now() - 13 * HOUR));
    const code = await freshCodeAboveWatermark(fx.idleAdmin, fx.idleSecret);
    const res = await mfaSvc.verifyMfaChallenge(stale.sessionToken, code, {
      ipAddress: testIp(43),
      userAgent: "phase10-review",
    });
    // SECURE expectation: verifyMfaChallenge resolves the session
    // row directly and never runs the F8 idle policy, so a session
    // idle 13h (privileged limit 12h) still passes the challenge and
    // is stamped verified. (Self-limiting in practice — the first
    // gated resolution afterwards deletes it — proven below.)
    expect(res.ok).toBe(false);

    const outcome = await enforcement.applySessionPolicy(
      stale.sessionToken,
      fx.idleAdmin,
      ["ADMIN"],
      true,
    );
    expect(outcome.expired).toBe(true);
  }, 60_000);
});

describe("controls — enrolment binding, secret hygiene, access gate", () => {
  it("enrolment is bound to the actor: an attacker cannot confirm against a victim's pending secret", async () => {
    const victimActor = await actorFor(fx.victimAdmin);
    const start = await mfaSvc.beginMfaEnrolment(victimActor as never);
    fx.victimSecret = start.secretBase32;

    const attackerActor = await actorFor(fx.attackerAdmin);
    // The attacker presents a code valid for the VICTIM's secret.
    // The service operates only on the actor's own row, and the
    // attacker has no enrolment in progress.
    await expect(
      mfaSvc.confirmMfaEnrolment(attackerActor as never, totpLib.totp(fx.victimSecret)),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);

    const victim = await prisma.user.findUnique({ where: { id: fx.victimAdmin } });
    expect(victim!.mfaEnabled).toBe(false);
    expect(victim!.mfaSecretEncrypted).not.toBeNull();
    const attacker = await prisma.user.findUnique({ where: { id: fx.attackerAdmin } });
    expect(attacker!.mfaEnabled).toBe(false);
    expect(attacker!.mfaSecretEncrypted).toBeNull();
  }, 60_000);

  it("the TOTP secret never lands in audit or login-attempt records", async () => {
    const audits = await prisma.auditLog.findMany({
      where: { OR: [{ actorId: fx.victimAdmin }, { entityId: fx.victimAdmin }] },
    });
    const blob = JSON.stringify(audits);
    expect(blob).not.toContain(fx.victimSecret);
    const victim = await prisma.user.findUnique({ where: { id: fx.victimAdmin } });
    expect(blob).not.toContain(victim!.mfaSecretEncrypted!);
    const attempts = await prisma.loginAttempt.findMany({
      where: { userId: fx.victimAdmin },
    });
    expect(JSON.stringify(attempts)).not.toContain(fx.victimSecret);
  }, 60_000);

  it("requireAccessGranted refuses enrolment-required and MFA-pending actors, admits a satisfied one", async () => {
    const base = await actorFor(fx.victimAdmin);
    const enrolmentRequired = {
      ...base,
      mfaEnrolled: false,
      mfaEnrolmentRequired: true,
      mfaPending: false,
    };
    expect(() => actorLib.requireAccessGranted(enrolmentRequired as never)).toThrow(
      actorLib.AuthorizationError,
    );
    const pending = { ...base, mfaEnrolled: true, mfaEnrolmentRequired: false, mfaPending: true };
    expect(() => actorLib.requireAccessGranted(pending as never)).toThrow(
      actorLib.AuthorizationError,
    );
    const satisfied = {
      ...base,
      mfaEnrolled: true,
      mfaEnrolmentRequired: false,
      mfaPending: false,
    };
    expect(() => actorLib.requireAccessGranted(satisfied as never)).not.toThrow();
  }, 60_000);
});

describe("controls — SystemSetting fallback; oversized values accepted (P10-R5 evidence)", () => {
  it("a malformed value falls back to the documented default; a huge positive value is taken as-is", async () => {
    const key = settingsSvc.SETTING_IDLE_TIMEOUT_STAFF_HOURS;
    const original = await prisma.systemSetting.findUnique({ where: { key } });
    try {
      await prisma.systemSetting.update({
        where: { key },
        data: { value: "not-a-number" },
      });
      expect(await settingsSvc.getIdleTimeoutMs(["WAREHOUSE_STAFF"])).toBe(24 * HOUR);

      // No sanity ceiling: 100000 hours (~11.4 years) is accepted
      // verbatim, silently disabling the staff idle gate for anyone
      // who can write the row (operator/DB access only — the app
      // itself exposes no settings write path).
      await prisma.systemSetting.update({ where: { key }, data: { value: 100000 } });
      expect(await settingsSvc.getIdleTimeoutMs(["WAREHOUSE_STAFF"])).toBe(100000 * HOUR);
    } finally {
      if (original) {
        await prisma.systemSetting.update({
          where: { key },
          data: { value: original.value as Prisma.InputJsonValue },
        });
      }
    }
  }, 60_000);
});

describe("evidence — client IP derivation trusts the forwarding header by default (P10-R6)", () => {
  const reader = (map: Record<string, string>) => ({
    get: (name: string) => map[name.toLowerCase()] ?? null,
  });

  it("default config: the client-supplied x-forwarded-for value keys the budget", async () => {
    const saved = process.env.TRUSTED_IP_HEADER;
    delete process.env.TRUSTED_IP_HEADER;
    try {
      // In a deployment NOT behind a header-overwriting proxy this
      // value is fully attacker-controlled: rotating it evades the
      // per-IP tracking budget (and the login throttle); fixing it
      // to a victim's IP burns the victim's budget instead.
      expect(
        clientIpLib.getClientIp(reader({ "x-forwarded-for": "203.0.113.99, 10.0.0.1" })),
      ).toBe("203.0.113.99");
      // IPv6 passes through unnormalised: two spellings of one
      // address are distinct budget buckets (exact-string counting
      // in tracking-access.ts).
      const a = clientIpLib.getClientIp(reader({ "x-forwarded-for": "2001:db8::1" }));
      const b = clientIpLib.getClientIp(
        reader({ "x-forwarded-for": "2001:0db8:0000:0000:0000:0000:0000:0001" }),
      );
      expect(a).toBe("2001:db8::1");
      expect(b).not.toBe(a);
    } finally {
      if (saved !== undefined) process.env.TRUSTED_IP_HEADER = saved;
    }
  }, 60_000);

  it("with TRUSTED_IP_HEADER=x-real-ip the spoofed x-forwarded-for is ignored", async () => {
    const saved = process.env.TRUSTED_IP_HEADER;
    process.env.TRUSTED_IP_HEADER = "x-real-ip";
    try {
      expect(
        clientIpLib.getClientIp(
          reader({ "x-forwarded-for": "203.0.113.99", "x-real-ip": "192.0.2.7" }),
        ),
      ).toBe("192.0.2.7");
    } finally {
      if (saved === undefined) delete process.env.TRUSTED_IP_HEADER;
      else process.env.TRUSTED_IP_HEADER = saved;
    }
  }, 60_000);
});

describe("regression control — complaint lockout composes with the Phase 10 per-IP layer", () => {
  it("5 wrong-phone complaints lock the code: the 6th, even with the correct phone, is denied identically", async () => {
    const ip = testIp(51);
    for (let i = 0; i < 5; i++) {
      await expect(
        ticketsSvc.raiseTrackingComplaint(
          fx.realTrackingId,
          {
            phone: "9800000001",
            category: "GENERAL",
            subject: "Review lockout probe",
            description: "Phase 10 review lockout composition probe.",
          },
          { ipAddress: ip },
        ),
      ).rejects.toBeInstanceOf(errors.NotFoundError);
    }
    await expect(
      ticketsSvc.raiseTrackingComplaint(
        fx.realTrackingId,
        {
          phone: RECIPIENT_PHONE,
          category: "GENERAL",
          subject: "Legitimate complaint",
          description: "Phase 10 review: correct phone while locked.",
        },
        { ipAddress: ip },
      ),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
    // The locked denial wrote nothing further against the code.
    const failures = await prisma.trackingAccessAttempt.count({
      where: { trackingId: fx.realTrackingId, succeeded: false },
    });
    expect(failures).toBe(5);
  }, 60_000);
});
