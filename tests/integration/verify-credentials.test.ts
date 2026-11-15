import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hash } from "bcryptjs";
import type { PrismaClient } from "@prisma/client";

import {
  IP_FAILURE_LIMIT,
  LOCK_DURATION_MS,
  MAX_FAILED_ATTEMPTS,
} from "@/lib/auth/login-guard";

// `server-only` throws outside a React Server Component environment; the
// service under test is server-only code, so stub the marker module.
vi.mock("server-only", () => ({}));

// Point the app at the bla_test database BEFORE the service layer (and
// its Prisma singleton) is imported. Refuse to run against anything else:
// these tests create users and login attempts. The dev URL is read from
// the app's env files directly — vitest does not load .env.local, so
// process.env.DATABASE_URL is not populated under test.
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

// Unique suffix per run: AuditLog rows are append-only (cannot be cleaned
// up), so test users are never reused across runs. bla_test is disposable.
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const email = (label: string) => `${label}-${RUN}@test.local`;

// Same per-run uniqueness for client IPs: LoginAttempt rows persist in
// bla_test and the per-IP throttle counts a 10-minute window, so fixed IPs
// let a previous run's failures throttle this run's lockout tests (the
// first attempt returns ip_throttled and never touches the counter).
const testIp = (host: number) =>
  `198.51.${1 + Math.floor(Math.random() * 250)}.${host}`;

let prisma: PrismaClient;
let verifyCredentials: typeof import("@/server/services/authentication").verifyCredentials;

beforeAll(async () => {
  ({ prisma } = await import("@/lib/db/prisma"));
  ({ verifyCredentials } = await import("@/server/services/authentication"));
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

async function createUser(
  userEmail: string,
  password: string,
  status = "ACTIVE",
): Promise<void> {
  const passwordHash = await hash(password, 10);
  await prisma.user.create({
    data: { email: userEmail, fullName: "Integration Test", passwordHash, status },
  });
}

const meta = (ipAddress: string) => ({ ipAddress, userAgent: "vitest" });

describe("verifyCredentials — lockout counter (F1)", () => {
  it(
    "increments by exactly 1 per failed attempt and locks at exactly 10",
    async () => {
      const userEmail = email("counter");
      await createUser(userEmail, "correct-horse");
      const m = meta(testIp(21));

      for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
        expect(await verifyCredentials(userEmail, "wrong", m)).toBeNull();
        const user = await prisma.user.findUnique({ where: { email: userEmail } });
        expect(user?.failedLoginAttempts).toBe(i);
        expect(user?.lockedUntil).toBeNull();
      }

      expect(await verifyCredentials(userEmail, "wrong", m)).toBeNull();
      const locked = await prisma.user.findUnique({ where: { email: userEmail } });
      // Reaching the threshold locks for LOCK_DURATION_MS and resets the
      // counter, and the lock is audited.
      expect(locked?.failedLoginAttempts).toBe(0);
      expect(locked?.lockedUntil).not.toBeNull();
      const until = locked!.lockedUntil!.getTime();
      expect(until).toBeGreaterThan(Date.now());
      expect(until).toBeLessThanOrEqual(Date.now() + LOCK_DURATION_MS + 5_000);
      const audit = await prisma.auditLog.findFirst({
        where: { actorId: locked!.id, action: "login.locked" },
      });
      expect(audit).not.toBeNull();
    },
    60_000,
  );

  it(
    "loses no increments under parallel failures and still locks",
    async () => {
      const userEmail = email("parallel");
      await createUser(userEmail, "correct-horse");
      const m = meta(testIp(22));

      const results = await Promise.all(
        Array.from({ length: MAX_FAILED_ATTEMPTS }, () =>
          verifyCredentials(userEmail, "wrong", m),
        ),
      );
      expect(results.every((r) => r === null)).toBe(true);

      // With the old read-modify-write counter, parallel attempts all
      // snapshot the same value and the lock never engages. The atomic
      // increment guarantees one of them lands on the threshold.
      const user = await prisma.user.findUnique({ where: { email: userEmail } });
      expect(user?.lockedUntil).not.toBeNull();
      expect(user!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    },
    60_000,
  );

  it(
    "resets the counter and lock on a successful login",
    async () => {
      const userEmail = email("reset");
      await createUser(userEmail, "correct-horse");
      await prisma.user.update({
        where: { email: userEmail },
        data: { failedLoginAttempts: 4 },
      });

      const result = await verifyCredentials(
        userEmail,
        "correct-horse",
        meta(testIp(23)),
      );
      expect(result?.email).toBe(userEmail);

      const user = await prisma.user.findUnique({ where: { email: userEmail } });
      expect(user?.failedLoginAttempts).toBe(0);
      expect(user?.lockedUntil).toBeNull();
      expect(user?.lastLoginAt).not.toBeNull();
    },
    30_000,
  );
});

describe("verifyCredentials — per-IP throttle (F3)", () => {
  it(
    "does not count ip_throttled rows toward the throttle (no self-extension)",
    async () => {
      const ip = testIp(24);
      // A window full of throttled rows only: under the old counting these
      // alone kept the IP blocked forever, because every new attempt added
      // another in-window failure row.
      await prisma.loginAttempt.createMany({
        data: Array.from({ length: IP_FAILURE_LIMIT }, () => ({
          email: email("ghost"),
          userId: null,
          success: false,
          reason: "ip_throttled",
          ipAddress: ip,
          userAgent: "vitest",
        })),
      });

      const target = email("nobody");
      expect(await verifyCredentials(target, "whatever", meta(ip))).toBeNull();
      const latest = await prisma.loginAttempt.findFirst({
        where: { ipAddress: ip, email: target },
        orderBy: { createdAt: "desc" },
      });
      // Not throttled: the attempt proceeded to the normal unknown-user path.
      expect(latest?.reason).toBe("unknown_user");
    },
    30_000,
  );

  it(
    "still throttles when real failures reach the limit",
    async () => {
      const ip = testIp(25);
      await prisma.loginAttempt.createMany({
        data: Array.from({ length: IP_FAILURE_LIMIT }, () => ({
          email: email("ghost"),
          userId: null,
          success: false,
          reason: "bad_password",
          ipAddress: ip,
          userAgent: "vitest",
        })),
      });

      const target = email("nobody");
      expect(await verifyCredentials(target, "whatever", meta(ip))).toBeNull();
      const latest = await prisma.loginAttempt.findFirst({
        where: { ipAddress: ip, email: target },
        orderBy: { createdAt: "desc" },
      });
      expect(latest?.reason).toBe("ip_throttled");
    },
    30_000,
  );
});

describe("verifyCredentials — account status", () => {
  it(
    "denies a suspended account even with the correct password",
    async () => {
      const userEmail = email("suspended");
      await createUser(userEmail, "correct-horse", "SUSPENDED");

      expect(
        await verifyCredentials(userEmail, "correct-horse", meta(testIp(26))),
      ).toBeNull();

      const attempt = await prisma.loginAttempt.findFirst({
        where: { email: userEmail },
        orderBy: { createdAt: "desc" },
      });
      expect(attempt?.reason).toBe("suspended");
      const user = await prisma.user.findUnique({ where: { email: userEmail } });
      expect(user?.failedLoginAttempts).toBe(0);
      expect(user?.lastLoginAt).toBeNull();
    },
    30_000,
  );
});
