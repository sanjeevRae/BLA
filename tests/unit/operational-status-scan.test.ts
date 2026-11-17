import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  findOperationalStatusWrites,
  scanSourceForStatusWrites,
} from "../helpers/operational-status-scan";

/**
 * Companion proof for the write-aware lifecycle source scan used by
 * tests/integration/bookings.test.ts ("is the only service that
 * writes operationalStatus"). Both directions are pinned:
 *  (a) read contexts — including the warehouse-home count() filter
 *      that the old flat regex false-flagged — produce NO hits;
 *  (b) write contexts — Prisma payloads, payload variables, direct
 *      assignment — ARE caught, including a planted offender file
 *      scanned through the real directory-scan entry point.
 */

const scan = (source: string) => scanSourceForStatusWrites(source, "probe.ts");

describe("operational-status scan — read contexts are allowed", () => {
  it("allows a where: filter nested under a relation in a count() (the warehouse-home shape)", () => {
    const source = `
      const ready = await prisma.inventoryRecord.count({
        where: {
          warehouseId: { in: ids },
          releasedAt: null,
          package: { operationalStatus: "READY_FOR_DELIVERY" },
        },
      });
    `;
    expect(scan(source)).toEqual([]);
  });

  it("allows a status literal in the where: of an update call (only data: is a write)", () => {
    const source = `
      await prisma.package.updateMany({
        where: { operationalStatus: "BOOKED" },
        data: { version: { increment: 1 } },
      });
    `;
    expect(scan(source)).toEqual([]);
  });

  it("allows comparisons, selects and orderBy", () => {
    const source = `
      if (pkg.operationalStatus === "DELIVERED") return;
      if (pkg.operationalStatus !== "READY_FOR_DELIVERY") throw new Error("no");
      const rows = await prisma.package.findMany({
        select: { operationalStatus: true },
        orderBy: { operationalStatus: "asc" },
        where: { operationalStatus: { in: ["BOOKED", "IN_TRANSIT"] } },
      });
    `;
    expect(scan(source)).toEqual([]);
  });

  it("allows view/audit mappings built from variables", () => {
    const source = `
      const view = {
        before: { operationalStatus: pkg.operationalStatus },
        after: { operationalStatus: transitioned.operationalStatus },
      };
    `;
    expect(scan(source)).toEqual([]);
  });

  it("allows a where object assigned to a variable, and ignores comments/strings", () => {
    const source = `
      const where = { package: { operationalStatus: "READY_FOR_DELIVERY" } };
      // operationalStatus: "DELIVERED" in a comment is not code
      const note = "operationalStatus: \\"DELIVERED\\" in a string is not code";
      await prisma.package.count({ where });
    `;
    expect(scan(source)).toEqual([]);
  });
});

describe("operational-status scan — write contexts are caught", () => {
  it("catches an update data payload", () => {
    const hits = scan(`
      await prisma.package.update({
        where: { id: pkg.id },
        data: { operationalStatus: "DELIVERED" },
      });
    `);
    expect(hits).toHaveLength(1);
    expect(hits[0].literal).toBe("DELIVERED");
  });

  it("catches create / updateMany / transactional writes", () => {
    expect(
      scan(`await tx.package.create({ data: { operationalStatus: "BOOKED" } });`),
    ).toHaveLength(1);
    expect(
      scan(`await prisma.package.updateMany({ data: { operationalStatus: "IN_TRANSIT" } });`),
    ).toHaveLength(1);
  });

  it("catches both branches of an upsert", () => {
    const hits = scan(`
      await prisma.package.upsert({
        where: { trackingId },
        create: { operationalStatus: "BOOKED" },
        update: { operationalStatus: "RECEIVED_AT_ORIGIN" },
      });
    `);
    expect(hits.map((h) => h.literal)).toEqual(["BOOKED", "RECEIVED_AT_ORIGIN"]);
  });

  it("catches a nested relation create under data:", () => {
    const hits = scan(`
      await prisma.shipment.create({
        data: { packages: { create: { operationalStatus: "BOOKED" } } },
      });
    `);
    expect(hits).toHaveLength(1);
  });

  it("catches a payload object assigned to a variable before the call", () => {
    expect(
      scan(`
        const data = { operationalStatus: "DELIVERED" };
        await prisma.package.update({ where: { id }, data });
      `),
    ).toHaveLength(1);
    expect(
      scan(`
        const updateData = { operationalStatus: "DELIVERED", version: 3 };
        await tx.package.update({ where: { id }, data: updateData });
      `),
    ).toHaveLength(1);
  });

  it("catches a direct assignment", () => {
    const hits = scan(`pkg.operationalStatus = "DELIVERED";`);
    expect(hits).toHaveLength(1);
    expect(hits[0].context).toBe("direct assignment");
  });

  it("catches a literal placed directly in a write call's argument object", () => {
    expect(scan(`await prisma.package.update({ operationalStatus: "BOOKED" });`)).toHaveLength(1);
  });
});

describe("operational-status scan — directory entry point", () => {
  it("flags a planted write-context offender file and passes a planted read-context file", () => {
    const dir = mkdtempSync(join(tmpdir(), "bla-scan-probe-"));
    try {
      writeFileSync(
        join(dir, "offender.ts"),
        `export async function bad(prisma: any, id: string) {
           await prisma.package.update({ where: { id }, data: { operationalStatus: "DELIVERED" } });
         }`,
      );
      writeFileSync(
        join(dir, "reader.ts"),
        `export async function good(prisma: any, ids: string[]) {
           return prisma.inventoryRecord.count({
             where: { warehouseId: { in: ids }, package: { operationalStatus: "READY_FOR_DELIVERY" } },
           });
         }`,
      );
      // The lifecycle service is the one legitimate writer and is
      // excluded by name, exactly as in the real services directory.
      writeFileSync(
        join(dir, "package-lifecycle.ts"),
        `export async function ok(prisma: any, id: string) {
           await prisma.package.update({ where: { id }, data: { operationalStatus: "DELIVERED" } });
         }`,
      );
      const hits = findOperationalStatusWrites(dir);
      expect(hits.map((h) => h.file)).toEqual(["offender.ts"]);
      expect(hits[0].literal).toBe("DELIVERED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes the real services tree", () => {
    const servicesDir = join(process.cwd(), "src/server/services");
    expect(findOperationalStatusWrites(servicesDir)).toEqual([]);
  });
});
