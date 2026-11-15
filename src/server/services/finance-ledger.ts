import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { DomainValidationError, NotFoundError } from "@/lib/errors";
import {
  DEBIT_NORMAL_KINDS,
  LEDGER_DIRECTIONS,
  LEDGER_TYPES,
} from "@/lib/finance/domain";

export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];
export type LedgerType = (typeof LEDGER_TYPES)[number];

/**
 * Finance core (Phase 7): chart of accounts + the double-entry
 * posting engine. Every money movement in the system is a journal —
 * a set of LedgerTransaction legs written inside the caller's DB
 * transaction, sharing one journalRef, with Σ DEBIT = Σ CREDIT
 * asserted before any row is written. Ledger rows are append-only
 * (DB triggers); corrections are mirror REVERSAL journals written by
 * `reverseJournal`. Account balances are always derived by summing
 * entries — there is no stored balance column anywhere.
 */

export type LedgerLeg = {
  accountCode: string;
  direction: LedgerDirection;
  amountPaisa: bigint;
  type: LedgerType;
  orderId?: string | null;
  packageId?: string | null;
  invoiceId?: string | null;
  paymentId?: string | null;
  codCollectionId?: string | null;
  remittanceId?: string | null;
  settlementId?: string | null;
  paymentMethod?: string | null;
  adjustmentId?: string | null;
  idempotencyKey?: string | null;
};

type Tx = Prisma.TransactionClient;

/** Next business-reference value from a named sequence, read inside
 * the caller's transaction (literal sequence names, as in
 * bookings/returns). */
export async function nextFinanceSequence(
  tx: Tx,
  sequence: "invoice_number_seq" | "remittance_number_seq" | "settlement_number_seq" | "ledger_reference_seq",
): Promise<bigint> {
  let rows: { value: bigint }[];
  switch (sequence) {
    case "invoice_number_seq":
      rows = await tx.$queryRaw<{ value: bigint }[]>`SELECT nextval('app.invoice_number_seq') AS value`;
      break;
    case "remittance_number_seq":
      rows = await tx.$queryRaw<{ value: bigint }[]>`SELECT nextval('app.remittance_number_seq') AS value`;
      break;
    case "settlement_number_seq":
      rows = await tx.$queryRaw<{ value: bigint }[]>`SELECT nextval('app.settlement_number_seq') AS value`;
      break;
    case "ledger_reference_seq":
      rows = await tx.$queryRaw<{ value: bigint }[]>`SELECT nextval('app.ledger_reference_seq') AS value`;
      break;
  }
  const value = rows[0]?.value;
  if (value === undefined) throw new Error(`Sequence ${sequence} returned no value`);
  return value;
}

/** Find-or-create a chart account inside a transaction. The account
 * codes are the vocabulary in lib/finance/domain; per-owner accounts
 * are created lazily on first use. */
export async function ensureAccount(
  tx: Tx,
  input: {
    code: string;
    name: string;
    kind: string;
    ownerType: "COMPANY" | "VENDOR" | "DRIVER";
    ownerVendorId?: string | null;
    ownerDriverId?: string | null;
  },
) {
  const existing = await tx.financialAccount.findUnique({ where: { code: input.code } });
  if (existing) return existing;
  return tx.financialAccount.create({
    data: {
      code: input.code,
      name: input.name,
      kind: input.kind,
      ownerType: input.ownerType,
      ownerVendorId: input.ownerVendorId ?? null,
      ownerDriverId: input.ownerDriverId ?? null,
    },
  });
}

export async function companyAccount(tx: Tx, code: string) {
  const account = await tx.financialAccount.findUnique({ where: { code } });
  if (!account) {
    throw new Error(
      `Company finance account ${code} is missing — the Phase 7 chart of accounts is not seeded.`,
    );
  }
  return account;
}

export async function vendorPayableAccount(tx: Tx, vendorId: string) {
  const vendor = await tx.vendor.findUnique({ where: { id: vendorId }, select: { id: true, businessName: true } });
  if (!vendor) throw new NotFoundError("Vendor not found");
  return ensureAccount(tx, {
    code: `VENDOR_PAYABLE:${vendorId}`,
    name: `Vendor payable — ${vendor.businessName}`,
    kind: "LIABILITY",
    ownerType: "VENDOR",
    ownerVendorId: vendorId,
  });
}

export async function driverCashAccount(tx: Tx, driverId: string) {
  const driver = await tx.driver.findUnique({
    where: { id: driverId },
    select: { id: true, user: { select: { fullName: true } } },
  });
  if (!driver) throw new NotFoundError("Driver not found");
  return ensureAccount(tx, {
    code: `DRIVER_CASH:${driverId}`,
    name: `Driver cash — ${driver.user.fullName}`,
    kind: "ASSET",
    ownerType: "DRIVER",
    ownerDriverId: driverId,
  });
}

/**
 * Post one balanced journal inside the caller's transaction. Throws
 * before writing anything if the legs do not balance, are empty, or
 * carry a non-positive amount — an unbalanced or partial journal can
 * never reach the ledger.
 */
export async function postJournal(
  tx: Tx,
  input: {
    journalRef: string;
    actorId: string;
    approvedById?: string | null;
    occurredAt?: Date;
    legs: LedgerLeg[];
  },
) {
  if (!input.journalRef) throw new DomainValidationError("A journal requires a reference");
  if (input.legs.length === 0) throw new DomainValidationError("A journal requires at least one entry");
  let debits = BigInt(0);
  let credits = BigInt(0);
  for (const leg of input.legs) {
    if (!LEDGER_DIRECTIONS.includes(leg.direction)) {
      throw new DomainValidationError(`Unknown ledger direction: ${leg.direction}`);
    }
    if (!LEDGER_TYPES.includes(leg.type)) {
      throw new DomainValidationError(`Unknown ledger entry type: ${leg.type}`);
    }
    if (leg.amountPaisa <= BigInt(0)) {
      throw new DomainValidationError("Ledger entries must be positive paisa amounts");
    }
    if (leg.direction === "DEBIT") debits += leg.amountPaisa;
    else credits += leg.amountPaisa;
  }
  if (debits !== credits) {
    throw new DomainValidationError(
      `Journal ${input.journalRef} is unbalanced: debits ${debits} != credits ${credits}`,
    );
  }
  if (debits === BigInt(0)) throw new DomainValidationError("A journal cannot total zero");

  const occurredAt = input.occurredAt ?? new Date();
  const created = [];
  for (const leg of input.legs) {
    const account = await tx.financialAccount.findUnique({ where: { code: leg.accountCode } });
    if (!account) {
      throw new Error(`Ledger account ${leg.accountCode} does not exist — post via the account helpers`);
    }
    const seq = await nextFinanceSequence(tx, "ledger_reference_seq");
    created.push(
      await tx.ledgerTransaction.create({
        data: {
          reference: `TXN-${seq.toString()}`,
          journalRef: input.journalRef,
          accountId: account.id,
          direction: leg.direction,
          amountPaisa: leg.amountPaisa,
          type: leg.type,
          orderId: leg.orderId ?? null,
          packageId: leg.packageId ?? null,
          invoiceId: leg.invoiceId ?? null,
          paymentId: leg.paymentId ?? null,
          codCollectionId: leg.codCollectionId ?? null,
          remittanceId: leg.remittanceId ?? null,
          settlementId: leg.settlementId ?? null,
          paymentMethod: leg.paymentMethod ?? null,
          occurredAt,
          actorId: input.actorId,
          approvedById: input.approvedById ?? null,
          adjustmentId: leg.adjustmentId ?? null,
          idempotencyKey: leg.idempotencyKey ?? null,
        },
      }),
    );
  }
  return created;
}

/**
 * Reverse a whole journal: mirror every leg with the opposite
 * direction under a new journalRef, each mirror pointing at its
 * original via reversalOfId (unique — a journal can be reversed at
 * most once). The originals are never touched.
 */
export async function reverseJournal(
  tx: Tx,
  input: { journalRef: string; actorId: string; reason: string },
) {
  const originals = await tx.ledgerTransaction.findMany({
    where: { journalRef: input.journalRef },
    orderBy: { createdAt: "asc" },
  });
  if (originals.length === 0) {
    throw new NotFoundError(`Journal ${input.journalRef} not found`);
  }
  const already = await tx.ledgerTransaction.findFirst({
    where: { reversalOfId: { in: originals.map((e) => e.id) } },
    select: { id: true },
  });
  if (already) throw new DomainValidationError(`Journal ${input.journalRef} has already been reversed`);

  const reversalRef = `REV:${input.journalRef}`;
  const created = [];
  for (const entry of originals) {
    const seq = await nextFinanceSequence(tx, "ledger_reference_seq");
    created.push(
      await tx.ledgerTransaction.create({
        data: {
          reference: `TXN-${seq.toString()}`,
          journalRef: reversalRef,
          accountId: entry.accountId,
          direction: entry.direction === "DEBIT" ? "CREDIT" : "DEBIT",
          amountPaisa: entry.amountPaisa,
          type: "REVERSAL",
          orderId: entry.orderId,
          packageId: entry.packageId,
          invoiceId: entry.invoiceId,
          paymentId: entry.paymentId,
          codCollectionId: entry.codCollectionId,
          remittanceId: entry.remittanceId,
          settlementId: entry.settlementId,
          paymentMethod: entry.paymentMethod,
          occurredAt: new Date(),
          actorId: input.actorId,
          reversalOfId: entry.id,
        },
      }),
    );
  }
  return created;
}

/**
 * Reverse only the still-live legs of a journal: legs that are not
 * themselves reversals and have not already been mirrored. Unlike
 * `reverseJournal` (which refuses when any leg was reversed before),
 * this tolerates journals whose earlier posting was already reversed
 * and re-posted under the same journalRef — the COD remittance
 * reject → re-submit cycle (Phase 7 review F1) posts `COD-<id>`
 * again after a rejection reversed the first posting, and a second
 * rejection must reverse only the live second posting. Returns the
 * mirror entries created (empty when nothing was live).
 */
export async function reverseLiveJournalLegs(
  tx: Tx,
  input: { journalRef: string; actorId: string },
) {
  const originals = await tx.ledgerTransaction.findMany({
    where: { journalRef: input.journalRef, reversalOfId: null, reversedBy: null },
    orderBy: { createdAt: "asc" },
  });
  if (originals.length === 0) return [];
  const reversalRef = `REV:${input.journalRef}`;
  const created = [];
  for (const entry of originals) {
    const seq = await nextFinanceSequence(tx, "ledger_reference_seq");
    created.push(
      await tx.ledgerTransaction.create({
        data: {
          reference: `TXN-${seq.toString()}`,
          journalRef: reversalRef,
          accountId: entry.accountId,
          direction: entry.direction === "DEBIT" ? "CREDIT" : "DEBIT",
          amountPaisa: entry.amountPaisa,
          type: "REVERSAL",
          orderId: entry.orderId,
          packageId: entry.packageId,
          invoiceId: entry.invoiceId,
          paymentId: entry.paymentId,
          codCollectionId: entry.codCollectionId,
          remittanceId: entry.remittanceId,
          settlementId: entry.settlementId,
          paymentMethod: entry.paymentMethod,
          occurredAt: new Date(),
          actorId: input.actorId,
          reversalOfId: entry.id,
        },
      }),
    );
  }
  return created;
}

/** Derived balance for one account: debit-normal kinds read
 * ΣDEBIT − ΣCREDIT; credit-normal kinds the reverse. */
export function balanceFromSums(
  kind: string,
  sums: { DEBIT?: bigint; CREDIT?: bigint },
): bigint {
  const debits = sums.DEBIT ?? BigInt(0);
  const credits = sums.CREDIT ?? BigInt(0);
  return DEBIT_NORMAL_KINDS.includes(kind) ? debits - credits : credits - debits;
}

export async function accountBalancePaisa(
  db: Tx | typeof prisma,
  accountId: string,
  kind: string,
): Promise<bigint> {
  const grouped = await db.ledgerTransaction.groupBy({
    by: ["direction"],
    where: { accountId },
    _sum: { amountPaisa: true },
  });
  const sums: { DEBIT?: bigint; CREDIT?: bigint } = {};
  for (const row of grouped) {
    sums[row.direction as LedgerDirection] = row._sum.amountPaisa ?? BigInt(0);
  }
  return balanceFromSums(kind, sums);
}

/** Signed raw position (ΣDEBIT − ΣCREDIT) for an account — used for
 * obligation views where the sign convention matters (e.g. a
 * driver's cash account: positive = cash still owed to the company). */
export async function accountNetPositionPaisa(
  db: Tx | typeof prisma,
  accountId: string,
): Promise<bigint> {
  const grouped = await db.ledgerTransaction.groupBy({
    by: ["direction"],
    where: { accountId },
    _sum: { amountPaisa: true },
  });
  let net = BigInt(0);
  for (const row of grouped) {
    const amount = row._sum.amountPaisa ?? BigInt(0);
    net += row.direction === "DEBIT" ? amount : -amount;
  }
  return net;
}
