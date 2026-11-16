import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 8 — tracking maintenance production entry point against
 * bla_test: runTrackingMaintenance (src/server/services/
 * tracking-maintenance.ts, driven by scripts/tracking-maintenance.ts)
 * runs the Phase 3 sweeps in order — expireAbandonedTrackingSessions
 * then pruneExpiredLocationPings — with counts-only results.
 *
 * Covers: dry-run changes nothing (sessions or pings); the real run
 * ends an abandoned session and leaves a fresh/active one alone;
 * an immediate re-run is idempotent (zeroes); the prune boundary —
 * the service deletes with `receivedAt < threshold`, so a ping
 * exactly at the retention threshold age is KEPT.
 *
 * The sweeps are global over the test DB, so assertions are scoped
 * to this suite's own fixtures (counts are `>=` where leftovers
 * from other suites could legitimately contribute, except the
 * idempotency re-run, which follows a full real run of this suite
 * and must report exact zeroes).
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
const email = (label: string) => `p8tm-${label}-${RUN}@bla.test`;
const DAY_MS = 24 * 60 * 60 * 1000;

let prisma: import("@prisma/client").PrismaClient;
let maintenanceSvc: typeof import("@/server/services/tracking-maintenance");
let trackingSvc: typeof import("@/server/services/tracking");

const fx: Record<string, string> = {};

async function makeDriverSession(
  label: string,
  startedAt: Date,
  status = "ACTIVE",
): Promise<{ sessionId: string; driverId: string }> {
  const { hash } = await import("bcryptjs");
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: `P8TM ${label}`,
      passwordHash: await hash("Fixture#2026", 10),
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    },
  });
  const driver = await prisma.driver.create({
    data: {
      userId: user.id,
      homeWarehouseId: fx.wh,
      licenseNumber: `LIC-P8TM-${label}-${RUN}`,
      licenseExpiry: new Date("2028-01-01"),
    },
  });
  // TrackingSession_assignment_shape_check: a DELIVERY session must
  // carry a deliveryBatchId (exactly one assignment).
  const batch = await prisma.deliveryBatch.create({
    data: {
      riderId: driver.id,
      warehouseId: fx.wh,
      batchDate: new Date(new Date().toISOString().slice(0, 10)),
      kind: "DELIVERY",
      status: "OPEN",
      createdById: user.id,
    },
  });
  const session = await prisma.trackingSession.create({
    data: {
      driverId: driver.id,
      deliveryBatchId: batch.id,
      trackingType: "DELIVERY",
      originWarehouseId: fx.wh,
      status,
      startReason: "DRIVER",
      permissionAcknowledgedAt: startedAt,
      startedAt,
      endedAt: status === "ENDED" ? startedAt : null,
      endReason: status === "ENDED" ? "DRIVER" : null,
    },
  });
  return { sessionId: session.id, driverId: driver.id };
}

async function makePing(
  sessionId: string,
  driverId: string,
  receivedAt: Date,
  sequenceId: number,
): Promise<string> {
  const ping = await prisma.driverLocationPing.create({
    data: {
      trackingSessionId: sessionId,
      driverId,
      latitude: 27.7,
      longitude: 85.3,
      accuracyMeters: 10,
      recordedAt: receivedAt,
      receivedAt,
      sequenceId,
      source: "BROWSER",
    },
  });
  return ping.id;
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
  maintenanceSvc = await import("@/server/services/tracking-maintenance");
  trackingSvc = await import("@/server/services/tracking");

  // Known config: the defaults (retentionDays 30,
  // abandonedSessionMinutes 120) must apply, so no operator
  // override row may leak in from another suite's leftovers.
  await prisma.systemSetting.deleteMany({ where: { key: "tracking.config" } });

  const warehouse = await prisma.warehouse.create({
    data: {
      code: `P8TM-${RUN}`,
      name: `P8TM Warehouse ${RUN}`,
      district: "Kathmandu",
      city: "Kathmandu",
      province: "Bagmati",
    },
  });
  fx.wh = warehouse.id;
});

describe("Phase 8 tracking maintenance — dry-run", () => {
  it("reports what would change and writes nothing", async () => {
    const now = new Date();
    const abandoned = await makeDriverSession(
      "dryold",
      new Date(now.getTime() - 3 * 60 * 60 * 1000),
    );
    fx.dryAbandoned = abandoned.sessionId;
    const host = await makeDriverSession(
      "dryhost",
      new Date(now.getTime() - 40 * DAY_MS),
      "ENDED",
    );
    fx.dryOldPing = await makePing(
      host.sessionId,
      host.driverId,
      new Date(now.getTime() - 31 * DAY_MS),
      1,
    );

    const result = await maintenanceSvc.runTrackingMaintenance({ dryRun: true, now });
    expect(result.dryRun).toBe(true);
    expect(result.retentionDays).toBe(30);
    expect(result.abandonedSessionMinutes).toBe(120);
    expect(result.sessionsEnded).toBeGreaterThanOrEqual(1);
    expect(result.pingsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Nothing was written: the abandoned session is still live and
    // the expired ping is still there.
    const session = await prisma.trackingSession.findUnique({
      where: { id: fx.dryAbandoned },
    });
    expect(session?.status).toBe("ACTIVE");
    expect(session?.endedAt).toBeNull();
    expect(
      await prisma.driverLocationPing.findUnique({ where: { id: fx.dryOldPing } }),
    ).not.toBeNull();
  });
});

describe("Phase 8 tracking maintenance — real run", () => {
  it("ends an abandoned session, leaves a fresh one alone", async () => {
    const now = new Date();
    const abandoned = await makeDriverSession(
      "old",
      new Date(now.getTime() - 3 * 60 * 60 * 1000),
    );
    const fresh = await makeDriverSession("fresh", now);
    fx.freshSession = fresh.sessionId;

    const result = await maintenanceSvc.runTrackingMaintenance({ now });
    expect(result.dryRun).toBe(false);
    expect(result.sessionsEnded).toBeGreaterThanOrEqual(1);

    const afterAbandoned = await prisma.trackingSession.findUnique({
      where: { id: abandoned.sessionId },
    });
    expect(afterAbandoned?.status).toBe("ENDED");
    expect(afterAbandoned?.endReason).toBe("EXPIRED");
    expect(afterAbandoned?.endedAt).not.toBeNull();

    const afterFresh = await prisma.trackingSession.findUnique({
      where: { id: fx.freshSession },
    });
    expect(afterFresh?.status).toBe("ACTIVE");
    expect(afterFresh?.endedAt).toBeNull();
  });

  it("is idempotent: an immediate second run changes nothing", async () => {
    const result = await maintenanceSvc.runTrackingMaintenance({});
    expect(result.sessionsEnded).toBe(0);
    expect(result.pingsDeleted).toBe(0);
    const fresh = await prisma.trackingSession.findUnique({
      where: { id: fx.freshSession },
    });
    expect(fresh?.status).toBe("ACTIVE");
  });
});

describe("Phase 8 tracking maintenance — prune boundary", () => {
  it("deletes only pings older than retention; a ping exactly at the threshold age is kept", async () => {
    const fixedNow = new Date();
    const host = await makeDriverSession(
      "prunehost",
      new Date(fixedNow.getTime() - 40 * DAY_MS),
      "ENDED",
    );
    const olderPing = await makePing(
      host.sessionId,
      host.driverId,
      new Date(fixedNow.getTime() - 30 * DAY_MS - 1000),
      1,
    );
    const boundaryPing = await makePing(
      host.sessionId,
      host.driverId,
      new Date(fixedNow.getTime() - 30 * DAY_MS),
      2,
    );
    const recentPing = await makePing(
      host.sessionId,
      host.driverId,
      new Date(fixedNow.getTime() - DAY_MS),
      3,
    );

    // Dry-run prune counts the same `lt` match without deleting.
    const dry = await trackingSvc.pruneExpiredLocationPings(fixedNow, { dryRun: true });
    expect(dry.deleted).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.driverLocationPing.findUnique({ where: { id: olderPing } }),
    ).not.toBeNull();

    const { deleted } = await trackingSvc.pruneExpiredLocationPings(fixedNow);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.driverLocationPing.findUnique({ where: { id: olderPing } }),
    ).toBeNull();
    // Exactly at the threshold: `receivedAt < threshold` is false,
    // so the boundary ping survives — as does the recent one.
    expect(
      await prisma.driverLocationPing.findUnique({ where: { id: boundaryPing } }),
    ).not.toBeNull();
    expect(
      await prisma.driverLocationPing.findUnique({ where: { id: recentPing } }),
    ).not.toBeNull();
  });
});
