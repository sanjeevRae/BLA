import "server-only";

import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { AuthorizationError, type ActorContext } from "@/lib/auth/actor";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import { REMITTANCE_METHODS } from "@/lib/finance/domain";
import {
  auditAccessDenied,
  isUniqueViolation,
  pageArgs,
  pageMeta,
  parse,
  requirePermAudited,
} from "@/server/services/scoping";
import { auditOps } from "@/server/services/warehouse-ops-shared";
import { raiseIncidentInTx } from "@/server/services/incidents";
import {
  accountNetPositionPaisa,
  companyAccount,
  driverCashAccount,
  nextFinanceSequence,
  postJournal,
  reverseLiveJournalLegs,
  vendorPayableAccount,
} from "@/server/services/finance-ledger";

/**
 * COD remittances (Phase 7; docs/cod-reconciliation.md §1–§3).
 *
 * A rider groups their Phase 6 DeliveryCodCollection rows into a
 * remittance. Submission posts each collection's COD_COLLECTED
 * journal (driver cash → vendor payable) exactly once. Finance —
 * never the rider, never warehouse staff — counts the handover:
 * an exact count verifies the remittance and moves the money into
 * COD clearing; any mismatch parks it in DISCREPANCY until a finance
 * decision (accept the counted amount with a mandatory note, or
 * reject) — the numbers are never silently adjusted. The rider's
 * obligation for a collection ends only to the verified paisa.
 */

type Tx = Prisma.TransactionClient;

/** Roles whose `cod.read` is company-wide (cod-reconciliation §5:
 * finance and admin read all COD records). Every other cod.read
 * holder is scoped: riders to themselves, vendors to remittances
 * covering their own collections, warehouse admins to remittances
 * handed in at — and riders homed at — their own warehouses
 * (Phase 7 review F2). */
const GLOBAL_COD_READ_ROLES: readonly string[] = ["FINANCE", "ADMIN", "SUPER_ADMIN"];

function hasGlobalCodScope(actor: ActorContext): boolean {
  return actor.roles.some((role) => GLOBAL_COD_READ_ROLES.includes(role));
}

const moneyString = z
  .string()
  .regex(/^\d+$/, "Amounts are integer paisa")
  .transform((v) => BigInt(v));

export const submitRemittanceSchema = z.object({
  collectionIds: z.array(z.string().uuid()).min(1).max(200),
  declaredAmountPaisa: moneyString,
  method: z.enum(REMITTANCE_METHODS).default("CASH"),
  warehouseId: z.string().uuid().optional(),
  notes: z.string().trim().max(500).optional(),
});

export const verifyRemittanceSchema = z.object({
  countedAmountPaisa: moneyString,
  notes: z.string().trim().max(500).optional(),
});

export const resolveRemittanceSchema = z.object({
  resolution: z.enum(["ACCEPTED_COUNTED", "REJECTED"]),
  note: z.string().trim().min(3).max(500),
});

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export type RemittanceView = {
  id: string;
  remittanceNumber: string;
  driverId: string;
  driverName: string | null;
  declaredAmountPaisa: string;
  countedAmountPaisa: string | null;
  discrepancyPaisa: string | null;
  expectedPaisa: string;
  collectedPaisa: string;
  status: string;
  method: string;
  resolution: string | null;
  submittedAt: string;
  verifiedAt: string | null;
  lineCount: number;
};

type RemittanceRow = Prisma.CodRemittanceGetPayload<{
  include: { driver: { include: { user: { select: { fullName: true } } } }; lines: true };
}>;

function toRemittanceView(row: RemittanceRow): RemittanceView {
  const expected = row.lines.reduce((s, l) => s + l.expectedPaisa, BigInt(0));
  const collected = row.lines.reduce((s, l) => s + l.collectedPaisa, BigInt(0));
  return {
    id: row.id,
    remittanceNumber: row.remittanceNumber,
    driverId: row.driverId,
    driverName: row.driver.user.fullName,
    declaredAmountPaisa: row.declaredAmountPaisa.toString(),
    countedAmountPaisa: row.countedAmountPaisa?.toString() ?? null,
    discrepancyPaisa: row.discrepancyPaisa?.toString() ?? null,
    expectedPaisa: expected.toString(),
    collectedPaisa: collected.toString(),
    status: row.status,
    method: row.method,
    resolution: row.resolution,
    submittedAt: row.submittedAt.toISOString(),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    lineCount: row.lines.length,
  };
}

// ---------------------------------------------------------------------------
// Rider COD position
// ---------------------------------------------------------------------------

export type RiderCodPosition = {
  driverId: string;
  awaitingRemittance: {
    collectionId: string;
    packageId: string;
    expectedPaisa: string;
    collectedPaisa: string;
    status: string;
    collectedAt: string;
  }[];
  awaitingRemittanceTotalPaisa: string;
  inOpenRemittancePaisa: string;
  verifiedRemittedPaisa: string;
  /** Ledger-derived: cash the rider still owes the company. */
  ledgerOwedPaisa: string;
};

export async function getRiderCodPosition(
  actor: ActorContext,
  driverIdInput?: string,
): Promise<RiderCodPosition> {
  await requirePermAudited(actor, "cod.read", "CodRemittance");
  let driverId = driverIdInput;
  if (actor.driverId) {
    if (driverIdInput && driverIdInput !== actor.driverId) {
      await auditAccessDenied(actor, "CodRemittance", {
        entityId: null,
        reason: "rider_scope_other_driver_position",
      });
      throw new AuthorizationError("Riders can only view their own COD position");
    }
    driverId = actor.driverId;
  }
  // Vendors never see a rider's COD position (F2): their scoped
  // cod.read covers remittances of their own collections only.
  if (actor.vendorId) {
    await auditAccessDenied(actor, "CodRemittance", {
      entityId: driverIdInput ?? null,
      reason: "vendor_scope_rider_cod_position",
    });
    throw new AuthorizationError("Vendors cannot view rider COD positions");
  }
  if (!driverId) throw new DomainValidationError("A driverId is required");
  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { id: true, userId: true, homeWarehouseId: true },
  });
  if (!driver) throw new NotFoundError("Driver not found");
  // Warehouse-scoped readers (warehouse admins) see only riders
  // homed at their own warehouses (F2).
  if (!actor.driverId && !hasGlobalCodScope(actor)) {
    if (!driver.homeWarehouseId || !actor.warehouseIds.includes(driver.homeWarehouseId)) {
      await auditAccessDenied(actor, "CodRemittance", {
        entityId: driverId,
        reason: "warehouse_scope_other_warehouse_driver_position",
      });
      throw new AuthorizationError(
        "Warehouse-scoped readers can only view COD positions for riders homed at their own warehouses",
      );
    }
  }

  const collections = await prisma.deliveryCodCollection.findMany({
    where: { collectedById: driver.userId },
    include: { remittanceLines: { include: { remittance: { select: { status: true, resolution: true } } } } },
    orderBy: { collectedAt: "asc" },
  });

  const awaiting: RiderCodPosition["awaitingRemittance"] = [];
  let awaitingTotal = BigInt(0);
  let inOpen = BigInt(0);
  let verified = BigInt(0);
  for (const collection of collections) {
    const line = collection.remittanceLines[0];
    if (!line) {
      awaiting.push({
        collectionId: collection.id,
        packageId: collection.packageId,
        expectedPaisa: collection.expectedPaisa.toString(),
        collectedPaisa: collection.collectedPaisa.toString(),
        status: collection.status,
        collectedAt: collection.collectedAt.toISOString(),
      });
      awaitingTotal += collection.collectedPaisa;
      continue;
    }
    const remittance = line.remittance;
    if (
      remittance.status === "VERIFIED" ||
      (remittance.status === "CLOSED" && remittance.resolution === "ACCEPTED_COUNTED")
    ) {
      verified += line.verifiedPaisa ?? BigInt(0);
      const unverifiedTail = collection.collectedPaisa - (line.verifiedPaisa ?? BigInt(0));
      if (unverifiedTail > BigInt(0)) inOpen += unverifiedTail;
    } else if (remittance.status !== "CLOSED") {
      inOpen += collection.collectedPaisa;
    }
  }

  const account = await prisma.financialAccount.findUnique({
    where: { code: `DRIVER_CASH:${driverId}` },
    select: { id: true },
  });
  const ledgerOwed = account ? await accountNetPositionPaisa(prisma, account.id) : BigInt(0);

  return {
    driverId,
    awaitingRemittance: awaiting,
    awaitingRemittanceTotalPaisa: awaitingTotal.toString(),
    inOpenRemittancePaisa: inOpen.toString(),
    verifiedRemittedPaisa: verified.toString(),
    ledgerOwedPaisa: ledgerOwed.toString(),
  };
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

/**
 * Group collections into a remittance and post each collection's
 * COD_COLLECTED journal in the same transaction. The collection
 * rows are locked first; a collection already on a remittance (or
 * not collected by this rider) aborts the whole submission.
 */
export async function submitRemittance(actor: ActorContext, input: unknown) {
  await requirePermAudited(actor, "cod.remit", "CodRemittance");
  const data = parse(submitRemittanceSchema, input);
  if (!actor.driverId) {
    await auditAccessDenied(actor, "CodRemittance", {
      entityId: null,
      reason: "remittance_requires_rider",
    });
    throw new AuthorizationError("Only a rider can submit a COD remittance");
  }
  const driverId = actor.driverId;
  if (data.declaredAmountPaisa < BigInt(0)) {
    throw new DomainValidationError("Declared amount cannot be negative");
  }

  try {
    const remittance = await prisma.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({
        where: { id: driverId },
        select: { id: true, userId: true, homeWarehouseId: true },
      });
      if (!driver) throw new NotFoundError("Driver profile not found");

      const collectionIds = [...new Set(data.collectionIds)].sort();
      if (collectionIds.length !== data.collectionIds.length) {
        throw new DomainValidationError("Duplicate collections in the remittance");
      }
      const collections = [];
      for (const id of collectionIds) {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "app"."DeliveryCodCollection" WHERE "id" = ${id} FOR UPDATE`;
        if (rows.length === 0) throw new NotFoundError(`COD collection ${id} not found`);
        const collection = await tx.deliveryCodCollection.findUnique({
          where: { id },
          include: { shipment: { select: { order: { select: { vendorId: true } } } } },
        });
        if (!collection) throw new NotFoundError(`COD collection ${id} not found`);
        if (collection.collectedById !== driver.userId) {
          await auditAccessDenied(actor, "CodRemittance", {
            entityId: id,
            reason: "collection_not_collected_by_rider",
          });
          throw new AuthorizationError("A rider can only remit COD they collected themselves");
        }
        const existingLine = await tx.codRemittanceLine.findUnique({
          where: { codCollectionId: id },
          select: { id: true },
        });
        if (existingLine) {
          throw new ConflictError("A COD collection is already on a remittance and cannot be remitted twice");
        }
        collections.push(collection);
      }

      const seq = await nextFinanceSequence(tx, "remittance_number_seq");
      const remittanceNumber = `RMT-${seq.toString()}`;
      const created = await tx.codRemittance.create({
        data: {
          remittanceNumber,
          driverId,
          submittedById: actor.userId,
          warehouseId: data.warehouseId ?? driver.homeWarehouseId,
          declaredAmountPaisa: data.declaredAmountPaisa,
          method: data.method,
          notes: data.notes ?? null,
          lines: {
            create: collections.map((c) => ({
              codCollectionId: c.id,
              expectedPaisa: c.expectedPaisa,
              collectedPaisa: c.collectedPaisa,
            })),
          },
        },
        include: { driver: { include: { user: { select: { fullName: true } } } }, lines: true },
      });

      // Post each collection's COD_COLLECTED journal exactly once:
      // DR driver cash / CR vendor payable (cod-reconciliation §2 —
      // the collection created the obligation; the remittance
      // submission is where Phase 7 first records it in the ledger).
      const driverAccount = await driverCashAccount(tx, driverId);
      for (const collection of collections) {
        // Exactly-once posting (Phase 7 review F1): the guard key
        // lives on the journal's DEBIT leg (the column is @unique,
        // so the two legs cannot carry the identical key — the
        // CREDIT leg carries a suffixed variant). A keyed leg whose
        // posting was later reversed (rejected remittance) does NOT
        // block re-posting; the re-post's keys are namespaced by the
        // new remittance number so the unique index still backstops
        // every posting.
        const baseKey = `cod-collection:${collection.id}`;
        const keyed = await tx.ledgerTransaction.findUnique({
          where: { idempotencyKey: baseKey },
          select: { id: true },
        });
        let debitKey = baseKey;
        if (keyed) {
          const reversal = await tx.ledgerTransaction.findUnique({
            where: { reversalOfId: keyed.id },
            select: { id: true },
          });
          if (!reversal) continue; // a live posting already exists
          debitKey = `${baseKey}:${created.remittanceNumber}`;
        }
        // The credit side is the vendor's payable; for a walk-in
        // customer order (no vendor) the COD is the company's own
        // money and credits COD clearing directly.
        const collectionVendorId = collection.shipment.order.vendorId;
        const creditAccount = collectionVendorId
          ? await vendorPayableAccount(tx, collectionVendorId)
          : await companyAccount(tx, "COD_CLEARING");
        await postJournal(tx, {
          journalRef: `COD-${collection.id}`,
          actorId: actor.userId,
          occurredAt: collection.collectedAt,
          legs: [
            {
              accountCode: driverAccount.code,
              direction: "DEBIT",
              amountPaisa: collection.collectedPaisa,
              type: "COD_COLLECTED",
              codCollectionId: collection.id,
              packageId: collection.packageId,
              idempotencyKey: debitKey,
            },
            {
              accountCode: creditAccount.code,
              direction: "CREDIT",
              amountPaisa: collection.collectedPaisa,
              type: "COD_COLLECTED",
              codCollectionId: collection.id,
              packageId: collection.packageId,
              idempotencyKey: `${debitKey}:credit`,
            },
          ],
        });
        await tx.package.updateMany({
          where: { id: collection.packageId, paymentStatus: "COD_DUE" },
          data: { paymentStatus: "COD_COLLECTED" },
        });
      }

      await auditOps(actor, "cod.remittance_submitted", "CodRemittance", created.id, {
        warehouseId: created.warehouseId,
        after: {
          remittanceNumber,
          declaredAmountPaisa: data.declaredAmountPaisa.toString(),
          collectionCount: collections.length,
        },
      });
      return created;
    });
    return toRemittanceView(remittance);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("A COD collection is already on a remittance and cannot be remitted twice");
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Verify + resolve
// ---------------------------------------------------------------------------

async function lockRemittance(tx: Tx, remittanceId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "app"."CodRemittance" WHERE "id" = ${remittanceId} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Remittance not found");
  const remittance = await tx.codRemittance.findUnique({
    where: { id: remittanceId },
    include: { lines: { orderBy: { createdAt: "asc" } } },
  });
  if (!remittance) throw new NotFoundError("Remittance not found");
  return remittance;
}

/** Move verified collections' money into COD clearing and mark the
 * packages remitted. Shared by the exact-verify path (full amounts)
 * and the accept-counted path (per-line verified amounts). */
async function postRemittanceJournal(
  tx: Tx,
  actor: ActorContext,
  remittance: { id: string; remittanceNumber: string; driverId: string },
  lines: { codCollectionId: string; collectedPaisa: bigint; verifiedPaisa: bigint | null }[],
) {
  const verifiedTotal = lines.reduce((s, l) => s + (l.verifiedPaisa ?? BigInt(0)), BigInt(0));
  if (verifiedTotal > BigInt(0)) {
    const driverAccount = await driverCashAccount(tx, remittance.driverId);
    const clearing = await companyAccount(tx, "COD_CLEARING");
    await postJournal(tx, {
      journalRef: remittance.remittanceNumber,
      actorId: actor.userId,
      legs: [
        {
          accountCode: clearing.code,
          direction: "DEBIT",
          amountPaisa: verifiedTotal,
          type: "COD_REMITTED",
          remittanceId: remittance.id,
        },
        {
          accountCode: driverAccount.code,
          direction: "CREDIT",
          amountPaisa: verifiedTotal,
          type: "COD_REMITTED",
          remittanceId: remittance.id,
        },
      ],
    });
  }
  for (const line of lines) {
    if ((line.verifiedPaisa ?? BigInt(0)) === line.collectedPaisa && line.collectedPaisa > BigInt(0)) {
      const collection = await tx.deliveryCodCollection.findUnique({
        where: { id: line.codCollectionId },
        select: { packageId: true },
      });
      if (collection) {
        await tx.package.updateMany({
          where: { id: collection.packageId, paymentStatus: "COD_COLLECTED" },
          data: { paymentStatus: "COD_REMITTED" },
        });
      }
    }
  }
}

/**
 * Finance counts the handover. Exact (counted = declared = Σ
 * collected) → VERIFIED and the clearing journal posts. Anything
 * else → DISCREPANCY with the difference stored; no money moves
 * until a finance resolution.
 */
export async function verifyRemittance(actor: ActorContext, remittanceId: string, input: unknown) {
  await requirePermAudited(actor, "cod.verify", "CodRemittance");
  const data = parse(verifyRemittanceSchema, input);

  const updated = await prisma.$transaction(async (tx) => {
    const remittance = await lockRemittance(tx, remittanceId);
    if (remittance.status !== "SUBMITTED" && remittance.status !== "UNDER_VERIFICATION") {
      throw new ConflictError(`Remittance is ${remittance.status} and cannot be verified`);
    }
    const collectedTotal = remittance.lines.reduce((s, l) => s + l.collectedPaisa, BigInt(0));
    const counted = data.countedAmountPaisa;
    const exact = counted === remittance.declaredAmountPaisa && counted === collectedTotal;

    if (exact) {
      for (const line of remittance.lines) {
        await tx.codRemittanceLine.update({
          where: { id: line.id },
          data: { verifiedPaisa: line.collectedPaisa },
        });
        line.verifiedPaisa = line.collectedPaisa;
      }
      await postRemittanceJournal(tx, actor, remittance, remittance.lines);
      const verified = await tx.codRemittance.update({
        where: { id: remittanceId },
        data: {
          status: "VERIFIED",
          countedAmountPaisa: counted,
          discrepancyPaisa: BigInt(0),
          verifiedById: actor.userId,
          verifiedAt: new Date(),
          notes: data.notes ?? remittance.notes,
        },
        include: { driver: { include: { user: { select: { fullName: true } } } }, lines: true },
      });
      await auditOps(actor, "cod.remittance_verified", "CodRemittance", remittanceId, {
        after: { countedAmountPaisa: counted.toString(), collectedPaisa: collectedTotal.toString() },
      });
      return verified;
    }

    const discrepancy = counted - remittance.declaredAmountPaisa;
    const parked = await tx.codRemittance.update({
      where: { id: remittanceId },
      data: {
        status: "DISCREPANCY",
        countedAmountPaisa: counted,
        discrepancyPaisa: discrepancy,
        verifiedById: actor.userId,
        verifiedAt: new Date(),
        notes: data.notes ?? remittance.notes,
      },
      include: { driver: { include: { user: { select: { fullName: true } } } }, lines: true },
    });
    // The discrepancy is on record from this moment.
    // cod-reconciliation §3.5: an incident is opened automatically.
    // Phase 8 wires it here, in the verification transaction —
    // idempotent per remittance (sourceKey), so a retried verify
    // can never open a second incident for the same discrepancy.
    // Finance is notified by the incident fan-out (finance
    // category routing).
    await raiseIncidentInTx(tx, {
      sourceKey: `cod-discrepancy:${remittanceId}`,
      category: "COD_DISCREPANCY",
      description:
        `COD remittance ${remittance.remittanceNumber} counted ${counted.toString()} paisa against ` +
        `${remittance.declaredAmountPaisa.toString()} declared — discrepancy of ${discrepancy.toString()} paisa.`,
      reporterId: actor.userId,
      warehouseId: remittance.warehouseId,
      remittanceId,
    });
    await auditOps(actor, "cod.discrepancy_opened", "CodRemittance", remittanceId, {
      after: {
        declaredAmountPaisa: remittance.declaredAmountPaisa.toString(),
        countedAmountPaisa: counted.toString(),
        discrepancyPaisa: discrepancy.toString(),
        collectedPaisa: collectedTotal.toString(),
      },
    });
    await auditOps(actor, "cod.remittance_discrepancy", "CodRemittance", remittanceId, {
      after: { countedAmountPaisa: counted.toString(), discrepancyPaisa: discrepancy.toString() },
    });
    return parked;
  });
  return toRemittanceView(updated);
}

/**
 * Finance decision on a discrepancy. ACCEPTED_COUNTED settles at the
 * counted amount: verified money moves to clearing, the shortfall
 * reduces the affected vendors' payables against the COD_DISCREPANCY
 * suspense account, and the rider keeps owing the shortfall in
 * their driver-cash account until it is topped up or written off
 * through an approved adjustment. REJECTED hands the collections
 * back to the rider untouched (lines are released; the header keeps
 * the full declared/counted history).
 */
export async function resolveRemittance(actor: ActorContext, remittanceId: string, input: unknown) {
  await requirePermAudited(actor, "cod.verify", "CodRemittance");
  const data = parse(resolveRemittanceSchema, input);

  const updated = await prisma.$transaction(async (tx) => {
    const remittance = await lockRemittance(tx, remittanceId);
    if (remittance.status !== "DISCREPANCY") {
      throw new ConflictError(`Remittance is ${remittance.status}; only a discrepancy can be resolved`);
    }

    if (data.resolution === "REJECTED") {
      // Hand the collections back untouched (Phase 7 review F1):
      // reverse each collection's live COD_COLLECTED journal so the
      // rider's ledger obligation and the credited payable unwind
      // with the rejection — otherwise a re-submission would post
      // the same collection a second time and double the position.
      // The packages return to COD_DUE so the re-submission's own
      // status step applies cleanly.
      for (const line of remittance.lines) {
        await reverseLiveJournalLegs(tx, {
          journalRef: `COD-${line.codCollectionId}`,
          actorId: actor.userId,
        });
        const collection = await tx.deliveryCodCollection.findUnique({
          where: { id: line.codCollectionId },
          select: { packageId: true },
        });
        if (collection) {
          await tx.package.updateMany({
            where: { id: collection.packageId, paymentStatus: "COD_COLLECTED" },
            data: { paymentStatus: "COD_DUE" },
          });
        }
      }
      await tx.codRemittanceLine.deleteMany({ where: { remittanceId } });
      const closed = await tx.codRemittance.update({
        where: { id: remittanceId },
        data: {
          status: "CLOSED",
          resolution: "REJECTED",
          resolutionNote: data.note,
          resolvedById: actor.userId,
          resolvedAt: new Date(),
        },
        include: { driver: { include: { user: { select: { fullName: true } } } }, lines: true },
      });
      await auditOps(actor, "cod.remittance_rejected", "CodRemittance", remittanceId, {
        after: { note: data.note },
      });
      return closed;
    }

    const counted = remittance.countedAmountPaisa;
    if (counted === null) throw new DomainValidationError("Remittance has no counted amount to accept");
    // Attribute the counted amount across lines in order; the tail
    // beyond the count stays unverified and out of settlement.
    let remaining = counted;
    for (const line of remittance.lines) {
      const verified = remaining >= line.collectedPaisa ? line.collectedPaisa : remaining > BigInt(0) ? remaining : BigInt(0);
      remaining -= verified;
      await tx.codRemittanceLine.update({ where: { id: line.id }, data: { verifiedPaisa: verified } });
      line.verifiedPaisa = verified;
    }
    await postRemittanceJournal(tx, actor, remittance, remittance.lines);

    const collectedTotal = remittance.lines.reduce((s, l) => s + l.collectedPaisa, BigInt(0));
    const shortfall = collectedTotal - counted;
    if (shortfall > BigInt(0)) {
      // Per-vendor shortfall: the unverified tail of each line
      // reduces that vendor's payable against the suspense account.
      const suspense = await companyAccount(tx, "COD_DISCREPANCY");
      const legs: Parameters<typeof postJournal>[1]["legs"] = [];
      // Group the tail by the account originally credited for the
      // collection (vendor payable, or COD clearing for walk-in
      // customer orders) — the shortfall debits that account back.
      const perAccount = new Map<string, bigint>();
      for (const line of remittance.lines) {
        const tail = line.collectedPaisa - (line.verifiedPaisa ?? BigInt(0));
        if (tail <= BigInt(0)) continue;
        const collection = await tx.deliveryCodCollection.findUnique({
          where: { id: line.codCollectionId },
          select: { shipment: { select: { order: { select: { vendorId: true } } } } },
        });
        if (!collection) throw new NotFoundError("COD collection not found");
        const tailVendorId = collection.shipment.order.vendorId;
        const account = tailVendorId
          ? await vendorPayableAccount(tx, tailVendorId)
          : await companyAccount(tx, "COD_CLEARING");
        perAccount.set(account.code, (perAccount.get(account.code) ?? BigInt(0)) + tail);
      }
      for (const [accountCode, amount] of perAccount) {
        legs.push({
          accountCode,
          direction: "DEBIT",
          amountPaisa: amount,
          type: "COD_REMITTED",
          remittanceId: remittance.id,
        });
        legs.push({
          accountCode: suspense.code,
          direction: "CREDIT",
          amountPaisa: amount,
          type: "COD_REMITTED",
          remittanceId: remittance.id,
        });
      }
      if (legs.length > 0) {
        await postJournal(tx, {
          journalRef: `${remittance.remittanceNumber}:SHORTFALL`,
          actorId: actor.userId,
          legs,
        });
      }
    }

    const closed = await tx.codRemittance.update({
      where: { id: remittanceId },
      data: {
        status: "CLOSED",
        resolution: "ACCEPTED_COUNTED",
        resolutionNote: data.note,
        resolvedById: actor.userId,
        resolvedAt: new Date(),
      },
      include: { driver: { include: { user: { select: { fullName: true } } } }, lines: true },
    });
    await auditOps(actor, "cod.remittance_accepted_counted", "CodRemittance", remittanceId, {
      after: {
        countedAmountPaisa: counted.toString(),
        shortfallPaisa: shortfall.toString(),
        note: data.note,
      },
    });
    return closed;
  });
  return toRemittanceView(updated);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listRemittances(
  actor: ActorContext,
  filters: { status?: string; page?: number; pageSize?: number } = {},
) {
  await requirePermAudited(actor, "cod.read", "CodRemittance");
  const { skip, take, page, pageSize } = pageArgs(filters.page ?? 1, filters.pageSize ?? 25);
  const conditions: Prisma.CodRemittanceWhereInput[] = [];
  if (actor.driverId) {
    conditions.push({ driverId: actor.driverId });
  } else if (actor.vendorId) {
    // Vendor scope (F2): only remittances covering at least one of
    // the vendor's own collections.
    conditions.push({
      lines: {
        some: { codCollection: { shipment: { order: { vendorId: actor.vendorId } } } },
      },
    });
  } else if (!hasGlobalCodScope(actor)) {
    // Warehouse scope (F2): only remittances handed in at the
    // actor's own warehouses (an empty membership matches nothing).
    conditions.push({ warehouseId: { in: actor.warehouseIds } });
  }
  if (filters.status) conditions.push({ status: filters.status });
  const where: Prisma.CodRemittanceWhereInput = conditions.length ? { AND: conditions } : {};
  const [total, rows] = await Promise.all([
    prisma.codRemittance.count({ where }),
    prisma.codRemittance.findMany({
      where,
      include: { driver: { include: { user: { select: { fullName: true } } } }, lines: true },
      orderBy: { submittedAt: "desc" },
      skip,
      take,
    }),
  ]);
  return { items: rows.map(toRemittanceView), meta: pageMeta(total, page, pageSize) };
}

export type RemittanceDetailView = RemittanceView & {
  lines: {
    id: string;
    codCollectionId: string;
    packageId: string;
    expectedPaisa: string;
    collectedPaisa: string;
    verifiedPaisa: string | null;
    collectionStatus: string;
  }[];
  resolutionNote: string | null;
  notes: string | null;
};

export async function getRemittance(actor: ActorContext, remittanceId: string): Promise<RemittanceDetailView> {
  await requirePermAudited(actor, "cod.read", "CodRemittance");
  const remittance = await prisma.codRemittance.findUnique({
    where: { id: remittanceId },
    include: {
      driver: { include: { user: { select: { fullName: true } } } },
      lines: {
        orderBy: { createdAt: "asc" },
        include: {
          codCollection: {
            select: {
              packageId: true,
              status: true,
              shipment: { select: { order: { select: { vendorId: true } } } },
            },
          },
        },
      },
    },
  });
  if (!remittance) throw new NotFoundError("Remittance not found");
  if (actor.driverId && remittance.driverId !== actor.driverId) {
    await auditAccessDenied(actor, "CodRemittance", {
      entityId: remittanceId,
      reason: "rider_scope_other_driver_remittance",
    });
    throw new AuthorizationError("Riders can only view their own remittances");
  }
  if (actor.vendorId) {
    // Vendor scope (F2): the remittance must cover at least one of
    // the vendor's own collections.
    const coversOwn = remittance.lines.some(
      (line) => line.codCollection.shipment.order.vendorId === actor.vendorId,
    );
    if (!coversOwn) {
      await auditAccessDenied(actor, "CodRemittance", {
        entityId: remittanceId,
        reason: "vendor_scope_other_vendor_remittance",
      });
      throw new AuthorizationError("Vendors can only view remittances covering their own collections");
    }
  } else if (!actor.driverId && !hasGlobalCodScope(actor)) {
    // Warehouse scope (F2): the remittance must have been handed in
    // at one of the actor's own warehouses.
    if (!remittance.warehouseId || !actor.warehouseIds.includes(remittance.warehouseId)) {
      await auditAccessDenied(actor, "CodRemittance", {
        entityId: remittanceId,
        reason: "warehouse_scope_other_warehouse_remittance",
      });
      throw new AuthorizationError(
        "Warehouse-scoped readers can only view remittances handed in at their own warehouses",
      );
    }
  }
  const base = toRemittanceView(remittance);
  return {
    ...base,
    lines: remittance.lines.map((line) => ({
      id: line.id,
      codCollectionId: line.codCollectionId,
      packageId: line.codCollection.packageId,
      expectedPaisa: line.expectedPaisa.toString(),
      collectedPaisa: line.collectedPaisa.toString(),
      verifiedPaisa: line.verifiedPaisa?.toString() ?? null,
      collectionStatus: line.codCollection.status,
    })),
    resolutionNote: remittance.resolutionNote,
    notes: remittance.notes,
  };
}
