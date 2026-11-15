"use server";

import { revalidatePath } from "next/cache";

import {
  AuthorizationError,
  getActorContext,
  requireAccessGranted,
  type ActorContext,
} from "@/lib/auth/permissions";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import type { ActionResult } from "@/server/actions/warehouses";
import {
  generateVendorInvoice,
  recordPayment,
  voidInvoice,
} from "@/server/services/invoices";
import {
  resolveRemittance,
  submitRemittance,
  verifyRemittance,
} from "@/server/services/cod-remittances";
import {
  approveSettlement,
  cancelSettlement,
  paySettlement,
  prepareSettlement,
} from "@/server/services/settlements";
import {
  approveAdjustment,
  approveRefund,
  createAdjustment,
  processRefund,
  rejectAdjustment,
  rejectRefund,
  requestRefund,
} from "@/server/services/finance-adjustments";

/**
 * Server Actions for Phase 7 finance — same contract as the other
 * modules (session actor, mustChangePassword gate, service-side
 * permission + scope checks with audited denials). Money inputs
 * travel as integer-paisa strings; the services validate with Zod.
 */

async function withActor<T>(fn: (actor: ActorContext) => Promise<T>): Promise<ActionResult<T>> {
  const actor = await getActorContext();
  if (!actor) return { success: false, error: "Authentication required" };
  try {
    requireAccessGranted(actor);
    return { success: true, data: await fn(actor) };
  } catch (error) {
    if (
      error instanceof AuthorizationError ||
      error instanceof NotFoundError ||
      error instanceof ConflictError ||
      error instanceof DomainValidationError
    ) {
      return { success: false, error: error.message };
    }
    throw error;
  }
}

function revalidateFinance() {
  revalidatePath("/finance");
  revalidatePath("/finance/invoices");
  revalidatePath("/finance/remittances");
  revalidatePath("/finance/settlements");
  revalidatePath("/finance/ledger");
  revalidatePath("/finance/adjustments");
  revalidatePath("/vendor/billing");
  revalidatePath("/rider/cod");
  revalidatePath("/admin/settlements");
  revalidatePath("/super-admin/settlements");
  revalidatePath("/super-admin/adjustments");
}

// --- Invoices + payments -----------------------------------------------------

export async function generateVendorInvoiceAction(input: { vendorId: string; dueInDays?: number }) {
  const result = await withActor((actor) => generateVendorInvoice(actor, input));
  if (result.success) revalidateFinance();
  return result;
}

export async function recordPaymentAction(input: unknown) {
  const result = await withActor((actor) => recordPayment(actor, input));
  if (result.success) revalidateFinance();
  return result;
}

export async function voidInvoiceAction(invoiceId: string, input: { reason: string }) {
  const result = await withActor((actor) => voidInvoice(actor, invoiceId, input));
  if (result.success) revalidateFinance();
  return result;
}

// --- COD remittances -----------------------------------------------------------

export async function submitRemittanceAction(input: unknown) {
  const result = await withActor((actor) => submitRemittance(actor, input));
  if (result.success) revalidateFinance();
  return result;
}

export async function verifyRemittanceAction(remittanceId: string, input: unknown) {
  const result = await withActor((actor) => verifyRemittance(actor, remittanceId, input));
  if (result.success) revalidateFinance();
  return result;
}

export async function resolveRemittanceAction(remittanceId: string, input: unknown) {
  const result = await withActor((actor) => resolveRemittance(actor, remittanceId, input));
  if (result.success) revalidateFinance();
  return result;
}

// --- Settlements -----------------------------------------------------------------

export async function prepareSettlementAction(input: unknown) {
  const result = await withActor((actor) => prepareSettlement(actor, input));
  if (result.success) revalidateFinance();
  return result;
}

export async function approveSettlementAction(settlementId: string) {
  const result = await withActor((actor) => approveSettlement(actor, settlementId));
  if (result.success) revalidateFinance();
  return result;
}

export async function paySettlementAction(settlementId: string, input: unknown) {
  const result = await withActor((actor) => paySettlement(actor, settlementId, input));
  if (result.success) revalidateFinance();
  return result;
}

export async function cancelSettlementAction(settlementId: string, input: { reason: string }) {
  const result = await withActor((actor) => cancelSettlement(actor, settlementId, input));
  if (result.success) revalidateFinance();
  return result;
}

// --- Refunds + adjustments --------------------------------------------------------

export async function requestRefundAction(input: unknown) {
  const result = await withActor((actor) => requestRefund(actor, input));
  if (result.success) revalidateFinance();
  return result;
}

export async function approveRefundAction(refundId: string) {
  const result = await withActor((actor) => approveRefund(actor, refundId));
  if (result.success) revalidateFinance();
  return result;
}

export async function rejectRefundAction(refundId: string) {
  const result = await withActor((actor) => rejectRefund(actor, refundId));
  if (result.success) revalidateFinance();
  return result;
}

export async function processRefundAction(refundId: string) {
  const result = await withActor((actor) => processRefund(actor, refundId));
  if (result.success) revalidateFinance();
  return result;
}

export async function createAdjustmentAction(input: unknown) {
  const result = await withActor((actor) => createAdjustment(actor, input));
  if (result.success) revalidateFinance();
  return result;
}

export async function approveAdjustmentAction(adjustmentId: string) {
  const result = await withActor((actor) => approveAdjustment(actor, adjustmentId));
  if (result.success) revalidateFinance();
  return result;
}

export async function rejectAdjustmentAction(adjustmentId: string) {
  const result = await withActor((actor) => rejectAdjustment(actor, adjustmentId));
  if (result.success) revalidateFinance();
  return result;
}
