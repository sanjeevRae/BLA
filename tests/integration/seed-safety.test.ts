import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hash } from "bcryptjs";
import type { PrismaClient } from "@prisma/client";

// `server-only` throws outside a React Server Component environment.
vi.mock("server-only", () => ({}));

// Same bla_test targeting pattern as the other integration suites.
function readEnvFile(file: string): Map<string, string> {
  const values = new Map<string, string>();
  try {
    const text = readFileSync(path.resolve(process.cwd(), file), "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) values.set(match[1], match[2].trim().replace(/^["']|["']$/g, ""));
    }
  } catch {
    // missing file — handled by the caller
  }
  return values;
}

const prismaEnv = readEnvFile("prisma/.env");
const devUrl = prismaEnv.get("DATABASE_URL") ?? readEnvFile(".env.local").get("DATABASE_URL");
if (!devUrl || new URL(devUrl).pathname !== "/bla_dev") {
  throw new Error("Seed test requires DATABASE_URL targeting bla_dev in prisma/.env");
}
const marker = "/bla_dev";
const idx = devUrl.lastIndexOf(marker);
const testUrl = devUrl.slice(0, idx) + "/bla_test" + devUrl.slice(idx + marker.length);
process.env.DATABASE_URL = testUrl;

const execFileAsync = promisify(execFile);
const TEST_WA_EMAIL = "ktm.admin@bla.test";

let prisma: PrismaClient;

async function runSeed(): Promise<string> {
  const { stdout } = await execFileAsync(
    path.resolve(process.cwd(), "node_modules/.bin/tsx"),
    ["prisma/seed.ts"],
    {
      cwd: process.cwd(),
      timeout: 180_000,
      env: {
        ...process.env,
        DATABASE_URL: testUrl,
        SEED_SUPER_ADMIN_EMAIL: prismaEnv.get("SEED_SUPER_ADMIN_EMAIL") ?? "",
        SEED_SUPER_ADMIN_PASSWORD: prismaEnv.get("SEED_SUPER_ADMIN_PASSWORD") ?? "",
        SEED_SUPER_ADMIN_NAME: prismaEnv.get("SEED_SUPER_ADMIN_NAME") ?? "Super Admin",
        SEED_TEST_WA_PASSWORD: prismaEnv.get("SEED_TEST_WA_PASSWORD") ?? "",
      },
    },
  );
  return stdout;
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/db/prisma"));
}, 30_000);

afterAll(async () => {
  // Leave bla_test's seeded test admin usable for manual smoke runs.
  const testPassword = prismaEnv.get("SEED_TEST_WA_PASSWORD");
  if (testPassword) {
    await prisma.user.updateMany({
      where: { email: TEST_WA_EMAIL },
      data: { passwordHash: await hash(testPassword, 10), status: "ACTIVE" },
    });
  }
  await prisma.$disconnect();
});

describe("P2-6 — seed safety for test warehouse admins", () => {
  it(
    "a re-run never resets a test admin's password or reactivates them",
    async () => {
      await runSeed();
      const created = await prisma.user.findUnique({ where: { email: TEST_WA_EMAIL } });
      expect(created).not.toBeNull();
      expect(created?.status).toBe("ACTIVE");

      // Simulate life after seeding: the account's password was changed
      // and the account was suspended.
      const sentinelHash = await hash("changed-after-seed-1", 10);
      await prisma.user.update({
        where: { email: TEST_WA_EMAIL },
        data: { passwordHash: sentinelHash, status: "SUSPENDED" },
      });

      const output = await runSeed();
      expect(output).toMatch(/already exists — leaving password and status untouched/);

      const after = await prisma.user.findUnique({ where: { email: TEST_WA_EMAIL } });
      expect(after?.passwordHash).toBe(sentinelHash);
      expect(after?.status).toBe("SUSPENDED");
    },
    300_000,
  );
});
