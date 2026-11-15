"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import {
  approveAdjustmentAction,
  approveRefundAction,
  approveSettlementAction,
  cancelSettlementAction,
  createAdjustmentAction,
  generateVendorInvoiceAction,
  paySettlementAction,
  prepareSettlementAction,
  processRefundAction,
  recordPaymentAction,
  rejectAdjustmentAction,
  rejectRefundAction,
  requestRefundAction,
  resolveRemittanceAction,
  submitRemittanceAction,
  verifyRemittanceAction,
  voidInvoiceAction,
} from "@/server/actions/finance";
import { PAYMENT_METHODS } from "@/lib/finance/domain";
import { formatPaisa } from "@/components/bookings/ui";
import {
  ErrorBox,
  dangerButtonClass,
  inputClass,
  labelClass,
  primaryButtonClass,
  subtleButtonClass,
} from "@/components/warehouses/ui";

/**
 * Phase 7 finance forms. Money is typed in NPR and converted to
 * integer-paisa strings with exact string math (no floats anywhere
 * in a money path); the server actions/services re-validate every
 * figure with Zod and the ledger rules.
 */

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      {children}
    </label>
  );
}

/** "1500" / "1500.7" / "1500.75" → paisa string; null when invalid. */
export function rupeesToPaisaString(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const paisa = BigInt(whole!) * BigInt(100) + BigInt((fraction + "00").slice(0, 2));
  return paisa.toString();
}

function useActionRunner() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function run<T>(
    fn: () => Promise<{ success: boolean; data?: T; error?: string }>,
    onSuccess?: (data: T) => string | void,
  ) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await fn();
      if (!result.success) {
        setError(result.error ?? "Something went wrong");
        return;
      }
      const message = onSuccess?.(result.data as T);
      if (typeof message === "string") setNotice(message);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, notice, run, setError };
}

export type FinanceVendorOption = { id: string; businessName: string };

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export function GenerateInvoiceForm({ vendors }: { vendors: FinanceVendorOption[] }) {
  const { busy, error, notice, run, setError } = useActionRunner();
  const [vendorId, setVendorId] = useState("");
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!vendorId) return setError("Choose a vendor");
    await run(
      () => generateVendorInvoiceAction({ vendorId }),
      (invoice) =>
        invoice
          ? `Invoice ${invoice.invoiceNumber} generated — ${formatPaisa(invoice.totalPaisa)}.`
          : "Nothing new to bill for this vendor — generation is idempotent.",
    );
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <Field label="Vendor">
        <select className={inputClass} value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
          <option value="">Select vendor…</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.businessName}
            </option>
          ))}
        </select>
      </Field>
      {error ? <ErrorBox message={error} /> : null}
      {notice ? <p className="text-[13px] text-ink">{notice}</p> : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Generating…" : "Generate invoice"}
        </button>
      </div>
      <p className="text-[12px] text-faint">
        Bills every fully-delivered, not-yet-invoiced shipment at its booked (snapshotted) charge.
        Re-running never double-bills.
      </p>
    </form>
  );
}

export function RecordPaymentForm({
  invoiceId,
  outstandingPaisa,
}: {
  invoiceId: string;
  outstandingPaisa: string;
}) {
  const { busy, error, notice, run, setError } = useActionRunner();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<string>("BANK_TRANSFER");
  const [transactionRef, setTransactionRef] = useState("");
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const paisa = rupeesToPaisaString(amount);
    if (!paisa) return setError("Enter an amount in NPR (e.g. 1500.50)");
    await run(
      () =>
        recordPaymentAction({
          amountPaisa: paisa,
          method,
          transactionRef: transactionRef.trim() || undefined,
          allocations: [{ invoiceId, amountPaisa: paisa }],
        }),
      () => "Payment recorded and posted to the ledger.",
    );
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`Amount (NPR) — outstanding ${formatPaisa(outstandingPaisa)}`}>
          <input
            className={inputClass}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
          />
        </Field>
        <Field label="Method">
          <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value)}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Transaction reference (optional)">
        <input
          className={inputClass}
          value={transactionRef}
          onChange={(e) => setTransactionRef(e.target.value)}
          placeholder="Bank / wallet reference"
        />
      </Field>
      {error ? <ErrorBox message={error} /> : null}
      {notice ? <p className="text-[13px] text-ink">{notice}</p> : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Recording…" : "Record payment"}
        </button>
      </div>
    </form>
  );
}

export function VoidInvoiceForm({ invoiceId }: { invoiceId: string }) {
  const { busy, error, run, setError } = useActionRunner();
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (reason.trim().length < 3) return setError("Give a reason for voiding");
    await run(() => voidInvoiceAction(invoiceId, { reason: reason.trim() }));
  }
  if (!open) {
    return (
      <button type="button" className={dangerButtonClass} onClick={() => setOpen(true)}>
        Void invoice…
      </button>
    );
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <Field label="Reason (the invoice is cancelled via reversing entries — never deleted)">
        <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {error ? <ErrorBox message={error} /> : null}
      <div className="flex gap-2">
        <button type="submit" className={dangerButtonClass} disabled={busy}>
          {busy ? "Voiding…" : "Void with reversal"}
        </button>
        <button type="button" className={subtleButtonClass} onClick={() => setOpen(false)}>
          Keep invoice
        </button>
      </div>
    </form>
  );
}

export function RequestRefundForm({ paymentId }: { paymentId: string }) {
  const { busy, error, notice, run, setError } = useActionRunner();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const paisa = rupeesToPaisaString(amount);
    if (!paisa) return setError("Enter an amount in NPR");
    if (reason.trim().length < 3) return setError("Give a reason");
    await run(
      () => requestRefundAction({ paymentId, amountPaisa: paisa, reason: reason.trim() }),
      () => "Refund requested — it needs a second person's approval before processing.",
    );
  }
  if (!open) {
    return (
      <button type="button" className={subtleButtonClass} onClick={() => setOpen(true)}>
        Request refund
      </button>
    );
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Refund amount (NPR)">
          <input className={inputClass} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Reason">
          <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      {error ? <ErrorBox message={error} /> : null}
      {notice ? <p className="text-[13px] text-ink">{notice}</p> : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Requesting…" : "Request refund"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// COD remittances
// ---------------------------------------------------------------------------

export type RemittanceCollectionOption = {
  collectionId: string;
  packageId: string;
  expectedPaisa: string;
  collectedPaisa: string;
  status: string;
};

export function SubmitRemittanceForm({ collections }: { collections: RemittanceCollectionOption[] }) {
  const { busy, error, notice, run, setError } = useActionRunner();
  const [selected, setSelected] = useState<Set<string>>(new Set(collections.map((c) => c.collectionId)));
  const [declared, setDeclared] = useState("");
  const selectedTotal = collections
    .filter((c) => selected.has(c.collectionId))
    .reduce((sum, c) => sum + BigInt(c.collectedPaisa), BigInt(0));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (selected.size === 0) return setError("Select at least one collection");
    const declaredPaisa = declared.trim() === "" ? selectedTotal.toString() : rupeesToPaisaString(declared);
    if (!declaredPaisa) return setError("Declared amount must be a valid NPR amount");
    await run(
      () =>
        submitRemittanceAction({
          collectionIds: [...selected],
          declaredAmountPaisa: declaredPaisa,
          method: "CASH",
        }),
      (remittance) => `Remittance ${remittance.remittanceNumber} submitted for finance verification.`,
    );
  }

  if (collections.length === 0) {
    return <p className="text-[13px] text-slate2">No COD collections are waiting to be remitted.</p>;
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <div className="grid gap-2">
        {collections.map((c) => (
          <label key={c.collectionId} className="flex items-center gap-2 text-[13px] text-ink">
            <input type="checkbox" checked={selected.has(c.collectionId)} onChange={() => toggle(c.collectionId)} />
            <span>
              Package {c.packageId.slice(0, 8)}… · collected {formatPaisa(c.collectedPaisa)} of{" "}
              {formatPaisa(c.expectedPaisa)} expected ({c.status})
            </span>
          </label>
        ))}
      </div>
      <Field label={`Amount you are handing over (NPR) — blank = full ${formatPaisa(selectedTotal.toString())}`}>
        <input
          className={inputClass}
          value={declared}
          onChange={(e) => setDeclared(e.target.value)}
          placeholder={formatPaisa(selectedTotal.toString())}
          inputMode="decimal"
        />
      </Field>
      {error ? <ErrorBox message={error} /> : null}
      {notice ? <p className="text-[13px] text-ink">{notice}</p> : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Submitting…" : "Submit remittance"}
        </button>
      </div>
    </form>
  );
}

export function VerifyRemittanceForm({
  remittanceId,
  declaredPaisa,
  collectedPaisa,
}: {
  remittanceId: string;
  declaredPaisa: string;
  collectedPaisa: string;
}) {
  const { busy, error, notice, run, setError } = useActionRunner();
  const [counted, setCounted] = useState("");
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const paisa = rupeesToPaisaString(counted);
    if (!paisa) return setError("Enter the counted amount in NPR");
    await run(
      () => verifyRemittanceAction(remittanceId, { countedAmountPaisa: paisa }),
      (remittance) =>
        remittance.status === "VERIFIED"
          ? "Count matches — remittance verified and posted to COD clearing."
          : "Count differs — remittance is in DISCREPANCY and needs a finance decision below.",
    );
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <p className="text-[13px] text-slate2">
        Rider declared {formatPaisa(declaredPaisa)} · collections total {formatPaisa(collectedPaisa)}. Count the
        physical handover and enter exactly what you received — a mismatch opens a discrepancy, it is never
        adjusted silently.
      </p>
      <Field label="Counted amount (NPR)">
        <input className={inputClass} value={counted} onChange={(e) => setCounted(e.target.value)} inputMode="decimal" />
      </Field>
      {error ? <ErrorBox message={error} /> : null}
      {notice ? <p className="text-[13px] text-ink">{notice}</p> : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Verifying…" : "Verify count"}
        </button>
      </div>
    </form>
  );
}

export function ResolveRemittanceForm({ remittanceId }: { remittanceId: string }) {
  const { busy, error, run, setError } = useActionRunner();
  const [resolution, setResolution] = useState<"ACCEPTED_COUNTED" | "REJECTED">("ACCEPTED_COUNTED");
  const [note, setNote] = useState("");
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (note.trim().length < 3) return setError("A decision note is mandatory");
    await run(() => resolveRemittanceAction(remittanceId, { resolution, note: note.trim() }));
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <Field label="Decision">
        <select className={inputClass} value={resolution} onChange={(e) => setResolution(e.target.value as typeof resolution)}>
          <option value="ACCEPTED_COUNTED">Accept the counted amount (shortfall stays on record)</option>
          <option value="REJECTED">Reject — collections return to the rider</option>
        </select>
      </Field>
      <Field label="Decision note (mandatory)">
        <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {error ? <ErrorBox message={error} /> : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Saving…" : "Record decision"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

export function PrepareSettlementForm({ vendors }: { vendors: FinanceVendorOption[] }) {
  const { busy, error, setError } = useActionRunner();
  const router = useRouter();
  const [vendorId, setVendorId] = useState("");
  const [deductionAmount, setDeductionAmount] = useState("");
  const [deductionDescription, setDeductionDescription] = useState("");
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!vendorId) return setError("Choose a vendor");
    const deductions = [];
    if (deductionAmount.trim() !== "") {
      const paisa = rupeesToPaisaString(deductionAmount);
      if (!paisa) return setError("Deduction amount must be a valid NPR amount");
      if (deductionDescription.trim().length < 3) return setError("Give the deduction a description");
      deductions.push({ amountPaisa: paisa, description: deductionDescription.trim() });
    }
    const result = await prepareSettlementAction({ vendorId, deductions });
    if (!result.success) return setError(result.error);
    router.push(`/finance/settlements/${result.data.id}`);
    router.refresh();
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <Field label="Vendor">
        <select className={inputClass} value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
          <option value="">Select vendor…</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.businessName}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Extra deduction (NPR, optional)">
          <input className={inputClass} value={deductionAmount} onChange={(e) => setDeductionAmount(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Deduction description">
          <input className={inputClass} value={deductionDescription} onChange={(e) => setDeductionDescription(e.target.value)} />
        </Field>
      </div>
      {error ? <ErrorBox message={error} /> : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Preparing…" : "Prepare settlement"}
        </button>
      </div>
      <p className="text-[12px] text-faint">
        Net = verified COD held − unpaid invoice charges − deductions. COD in discrepancy never enters a
        settlement.
      </p>
    </form>
  );
}

export function SettlementActions({
  settlementId,
  status,
  canApprove,
  canPay,
  basePath,
}: {
  settlementId: string;
  status: string;
  canApprove: boolean;
  canPay: boolean;
  basePath: string;
}) {
  const { busy, error, run, setError } = useActionRunner();
  const router = useRouter();
  const [method, setMethod] = useState("BANK_TRANSFER");
  const [transactionRef, setTransactionRef] = useState("");
  const [cancelReason, setCancelReason] = useState("");

  return (
    <div className="grid gap-3">
      {error ? <ErrorBox message={error} /> : null}
      {status === "PENDING" && canApprove ? (
        <div>
          <button
            type="button"
            className={primaryButtonClass}
            disabled={busy}
            onClick={() => void run(() => approveSettlementAction(settlementId))}
          >
            {busy ? "Approving…" : "Approve settlement"}
          </button>
        </div>
      ) : null}
      {status === "APPROVED" && canPay ? (
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Payout method">
              <select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value)}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Transaction reference (optional)">
              <input className={inputClass} value={transactionRef} onChange={(e) => setTransactionRef(e.target.value)} />
            </Field>
          </div>
          <div>
            <button
              type="button"
              className={primaryButtonClass}
              disabled={busy}
              onClick={() =>
                void run(
                  () => paySettlementAction(settlementId, { method, transactionRef: transactionRef.trim() || undefined }),
                  () => {
                    router.push(`${basePath}`);
                  },
                )
              }
            >
              {busy ? "Paying…" : "Pay settlement"}
            </button>
          </div>
        </div>
      ) : null}
      {(status === "PENDING" || status === "APPROVED") && canPay ? (
        <div className="grid gap-2">
          <Field label="Cancel settlement — reason">
            <input className={inputClass} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
          </Field>
          <div>
            <button
              type="button"
              className={dangerButtonClass}
              disabled={busy}
              onClick={() => {
                if (cancelReason.trim().length < 3) return setError("Give a cancellation reason");
                void run(() => cancelSettlementAction(settlementId, { reason: cancelReason.trim() }));
              }}
            >
              Cancel settlement
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Adjustments + refund decisions
// ---------------------------------------------------------------------------

export function CreateAdjustmentForm() {
  const { busy, error, notice, run, setError } = useActionRunner();
  const [targetType, setTargetType] = useState("INVOICE");
  const [targetId, setTargetId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const paisa = rupeesToPaisaString(amount);
    if (!paisa) return setError("Enter an amount in NPR");
    if (!/^[0-9a-fA-F-]{36}$/.test(targetId.trim())) return setError("Enter the target record's id");
    if (reason.trim().length < 3) return setError("Give a reason");
    await run(
      () =>
        createAdjustmentAction({
          targetType,
          targetId: targetId.trim(),
          amountPaisa: paisa,
          reason: reason.trim(),
        }),
      () => "Adjustment requested — a different approver must approve it (four-eyes).",
    );
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Target type">
          <select className={inputClass} value={targetType} onChange={(e) => setTargetType(e.target.value)}>
            <option value="INVOICE">Invoice credit note</option>
            <option value="COD_COLLECTION">COD collection write-off</option>
          </select>
        </Field>
        <Field label="Target record id">
          <input className={inputClass} value={targetId} onChange={(e) => setTargetId(e.target.value)} placeholder="UUID" />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount (NPR)">
          <input className={inputClass} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Reason">
          <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      {error ? <ErrorBox message={error} /> : null}
      {notice ? <p className="text-[13px] text-ink">{notice}</p> : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Creating…" : "Create adjustment request"}
        </button>
      </div>
    </form>
  );
}

export function AdjustmentDecisionButtons({ adjustmentId, status }: { adjustmentId: string; status: string }) {
  const { busy, error, run } = useActionRunner();
  if (status !== "REQUESTED") return null;
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={subtleButtonClass}
        disabled={busy}
        onClick={() => void run(() => approveAdjustmentAction(adjustmentId))}
      >
        Approve + apply
      </button>
      <button
        type="button"
        className={subtleButtonClass}
        disabled={busy}
        onClick={() => void run(() => rejectAdjustmentAction(adjustmentId))}
      >
        Reject
      </button>
      {error ? <span className="text-[12px] text-red-700">{error}</span> : null}
    </span>
  );
}

export function RefundDecisionButtons({
  refundId,
  status,
}: {
  refundId: string;
  status: string;
}) {
  const { busy, error, run } = useActionRunner();
  return (
    <span className="inline-flex items-center gap-2">
      {status === "REQUESTED" ? (
        <>
          <button type="button" className={subtleButtonClass} disabled={busy} onClick={() => void run(() => approveRefundAction(refundId))}>
            Approve
          </button>
          <button type="button" className={subtleButtonClass} disabled={busy} onClick={() => void run(() => rejectRefundAction(refundId))}>
            Reject
          </button>
        </>
      ) : null}
      {status === "APPROVED" ? (
        <button type="button" className={subtleButtonClass} disabled={busy} onClick={() => void run(() => processRefundAction(refundId))}>
          Process refund
        </button>
      ) : null}
      {error ? <span className="text-[12px] text-red-700">{error}</span> : null}
    </span>
  );
}
