"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import {
  addBatchPackagesAction,
  approveReturnAction,
  cancelAssignmentAction,
  cancelBatchAction,
  closeBatchAction,
  completeReturnAction,
  confirmDeliveryAction,
  confirmPickupAction,
  confirmPickupCollectionAction,
  createDeliveryBatchAction,
  initiateReturnAction,
  inspectReturnAction,
  recordDeliveryAttemptAction,
  recordPickupAttemptAction,
  reassignAssignmentAction,
  reassignBatchAction,
  regenerateOtpAction,
  rejectReturnAction,
  scanBackPackageAction,
} from "@/server/actions/deliveries";
import { PACKAGE_CONDITIONS } from "@/lib/bookings/domain";
import { sendTrackingEventUpdate } from "@/lib/tracking/client-registry";
import {
  DELIVERY_ATTEMPT_RESULTS,
  DELIVERY_CONTACT_OUTCOMES,
  DELIVERY_NEXT_ACTIONS,
  RETURN_CHARGE_BEARERS,
  RETURN_REASONS,
} from "@/lib/deliveries/domain";
import { formatPaisa } from "@/components/bookings/ui";
import {
  ErrorBox,
  dangerButtonClass,
  inputClass,
  labelClass,
  primaryButtonClass,
  subtleButtonClass,
} from "@/components/warehouses/ui";
import type {
  DeliveryRiderOption,
  RiderAssignmentView,
} from "@/server/services/deliveries";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      {children}
    </label>
  );
}

function OkBox({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-line bg-greenbg px-3 py-2 text-[13px] text-green">
      {message}
    </div>
  );
}

export interface WarehouseOption {
  id: string;
  code: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Create batch (dispatcher)
// ---------------------------------------------------------------------------

export function CreateBatchForm({
  warehouses,
  ridersByWarehouse,
  basePath,
}: {
  warehouses: WarehouseOption[];
  ridersByWarehouse: Record<string, DeliveryRiderOption[]>;
  basePath: string;
}) {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? "");
  const [riderUserId, setRiderUserId] = useState("");
  const [batchDate, setBatchDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const riders = ridersByWarehouse[warehouseId] ?? [];

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await createDeliveryBatchAction({
      warehouseId,
      riderUserId,
      batchDate,
      kind: "DELIVERY",
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    router.push(`${basePath}/deliveries/${result.data.id}`);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Warehouse">
          <select
            className={inputClass}
            value={warehouseId}
            onChange={(e) => {
              setWarehouseId(e.target.value);
              setRiderUserId("");
            }}
            required
          >
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.code})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Rider">
          <select
            className={inputClass}
            value={riderUserId}
            onChange={(e) => setRiderUserId(e.target.value)}
            required
          >
            <option value="">Select rider…</option>
            {riders.map((r) => (
              <option key={r.userId} value={r.userId} disabled={r.blockers.length > 0}>
                {r.fullName}
                {r.blockers.length > 0 ? ` — ${r.blockers.join("; ")}` : ` (${r.availabilityStatus})`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Batch date">
          <input
            className={inputClass}
            type="date"
            value={batchDate}
            onChange={(e) => setBatchDate(e.target.value)}
            required
          />
        </Field>
      </div>
      {riders.length === 0 ? (
        <p className="text-[13px] text-slate2">
          No riders are linked to this warehouse yet. A rider needs the RIDER role, a driver
          profile homed here (or a membership), the DELIVERY capability and a valid licence.
        </p>
      ) : null}
      {error ? <ErrorBox message={error} /> : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Creating…" : "Create batch"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Add packages to a batch (dispatcher)
// ---------------------------------------------------------------------------

export interface EligiblePackageOption {
  packageId: string;
  trackingId: string;
  status: string;
  recipientName: string;
  destinationCity: string | null;
  destinationDistrict: string | null;
  codAmountPaisa: string;
}

export function AddPackagesForm({
  batchId,
  eligible,
}: {
  batchId: string;
  eligible: EligiblePackageOption[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await addBatchPackagesAction(batchId, {
      packageIds: [...selected],
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    const parts = [`${result.data.added.length} package(s) assigned.`];
    if (result.data.rejected.length > 0) {
      parts.push(
        "Rejected: " +
          result.data.rejected.map((r) => `${r.trackingId ?? r.packageId} (${r.reason})`).join("; "),
      );
    }
    setNotice(parts.join(" "));
    setSelected(new Set());
    router.refresh();
  }

  if (eligible.length === 0) {
    return (
      <p className="text-[13px] text-slate2">
        No packages are ready for delivery assignment at this warehouse right now.
      </p>
    );
  }
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="grid gap-2">
        {eligible.map((p) => (
          <label
            key={p.packageId}
            className="flex cursor-pointer items-center gap-3 rounded-md border border-line bg-page px-3 py-2"
          >
            <input
              type="checkbox"
              checked={selected.has(p.packageId)}
              onChange={() => toggle(p.packageId)}
            />
            <span className="font-mono text-[13px] font-semibold text-ink">{p.trackingId}</span>
            <span className="text-[13px] text-slate2">
              {p.recipientName} · {p.destinationCity ?? "—"} ({p.destinationDistrict ?? "—"}) ·{" "}
              {p.status}
              {BigInt(p.codAmountPaisa) > BigInt(0)
                ? ` · COD ${formatPaisa(BigInt(p.codAmountPaisa))}`
                : ""}
            </span>
          </label>
        ))}
      </div>
      {error ? <ErrorBox message={error} /> : null}
      {notice ? <OkBox message={notice} /> : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy || selected.size === 0}>
          {busy ? "Assigning…" : `Assign ${selected.size} package(s)`}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Assignment / batch dispatcher actions
// ---------------------------------------------------------------------------

export function CancelAssignmentButton({ assignmentId }: { assignmentId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (reason.trim().length < 3) {
      setError("Give a short reason (at least 3 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await cancelAssignmentAction(assignmentId, { reason: reason.trim() });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <input
        className={inputClass}
        placeholder="Cancel reason"
        aria-label="Cancel reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button type="button" className={dangerButtonClass} disabled={busy} onClick={onClick}>
        {busy ? "Cancelling…" : "Cancel assignment"}
      </button>
      {error ? <span className="text-[12px] text-red">{error}</span> : null}
    </span>
  );
}

export function ReassignForm({
  assignmentId,
  riders,
}: {
  assignmentId: string;
  riders: DeliveryRiderOption[];
}) {
  const router = useRouter();
  const [riderUserId, setRiderUserId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (!riderUserId) {
      setError("Select the new rider.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await reassignAssignmentAction(assignmentId, { riderUserId });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <select
        className={inputClass}
        value={riderUserId}
        onChange={(e) => setRiderUserId(e.target.value)}
        aria-label="Reassign to rider"
      >
        <option value="">Reassign to…</option>
        {riders.map((r) => (
          <option key={r.userId} value={r.userId} disabled={r.blockers.length > 0}>
            {r.fullName}
            {r.blockers.length > 0 ? ` — ${r.blockers.join("; ")}` : ""}
          </option>
        ))}
      </select>
      <button type="button" className={subtleButtonClass} disabled={busy} onClick={onClick}>
        {busy ? "Reassigning…" : "Reassign"}
      </button>
      {error ? <span className="text-[12px] text-red">{error}</span> : null}
    </span>
  );
}

export function ReassignBatchForm({
  batchId,
  status,
  currentRiderUserId,
  riders,
}: {
  batchId: string;
  status: string;
  currentRiderUserId: string;
  riders: DeliveryRiderOption[];
}) {
  const router = useRouter();
  const [riderUserId, setRiderUserId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status !== "OPEN" && status !== "IN_PROGRESS") return null;

  async function onClick() {
    if (!riderUserId) {
      setError("Select the new rider.");
      return;
    }
    if (reason.trim().length < 3) {
      setError("Give a short reason (at least 3 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await reassignBatchAction(batchId, {
      riderUserId,
      reason: reason.trim(),
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setNotice(
      `${result.data.moved.total} package(s) moved to the new rider` +
        (result.data.oldBatchClosed ? " — this batch was closed." : "."),
    );
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={inputClass}
          value={riderUserId}
          onChange={(e) => setRiderUserId(e.target.value)}
          aria-label="Reassign whole batch to rider"
        >
          <option value="">Reassign whole batch to…</option>
          {riders
            .filter((r) => r.userId !== currentRiderUserId)
            .map((r) => (
              <option key={r.userId} value={r.userId} disabled={r.blockers.length > 0}>
                {r.fullName}
                {r.blockers.length > 0 ? ` — ${r.blockers.join("; ")}` : ""}
              </option>
            ))}
        </select>
        <input
          className={inputClass}
          placeholder="Reason (required)"
          aria-label="Reassignment reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button type="button" className={subtleButtonClass} disabled={busy} onClick={onClick}>
          {busy ? "Reassigning…" : "Reassign batch"}
        </button>
      </div>
      <p className="text-[12px] text-slate2">
        Moves every waiting and collected package to the new rider — collected packages keep
        their custody chain and get a fresh delivery code for the recipient.
      </p>
      {error ? <ErrorBox message={error} /> : null}
      {notice ? <OkBox message={notice} /> : null}
    </div>
  );
}

export function BatchCloseButtons({
  batchId,
  status,
  showCancel = true,
}: {
  batchId: string;
  status: string;
  showCancel?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"close" | "cancel" | null>(null);

  async function run(kind: "close" | "cancel") {
    setBusy(kind);
    setError(null);
    const result =
      kind === "close" ? await closeBatchAction(batchId) : await cancelBatchAction(batchId);
    setBusy(null);
    if (!result.success) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  if (status !== "OPEN" && status !== "IN_PROGRESS") return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={primaryButtonClass}
          disabled={busy !== null}
          onClick={() => run("close")}
        >
          {busy === "close" ? "Closing…" : "Close batch (end of day)"}
        </button>
        {showCancel ? (
          <button
            type="button"
            className={dangerButtonClass}
            disabled={busy !== null}
            onClick={() => run("cancel")}
          >
            {busy === "cancel" ? "Cancelling…" : "Cancel batch"}
          </button>
        ) : null}
      </div>
      {error ? <ErrorBox message={error} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Warehouse scan-back (undelivered package returns to stock)
// ---------------------------------------------------------------------------

export function ScanBackForm({ warehouses }: { warehouses: WarehouseOption[] }) {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? "");
  const [trackingId, setTrackingId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await scanBackPackageAction({
      warehouseId,
      trackingId: trackingId.trim().toUpperCase(),
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setNotice(
      result.data.returnRequest
        ? `${result.data.trackingId} scanned back — return ${result.data.returnRequest.returnNumber} is now RECEIVED.`
        : `${result.data.trackingId} scanned back into stock (READY_FOR_DELIVERY).`,
    );
    setTrackingId("");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Warehouse">
          <select
            className={inputClass}
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            required
          >
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.code})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tracking ID scanned back from the rider">
          <input
            className={inputClass}
            value={trackingId}
            onChange={(e) => setTrackingId(e.target.value)}
            placeholder="BLA-…"
            required
          />
        </Field>
      </div>
      {error ? <ErrorBox message={error} /> : null}
      {notice ? <OkBox message={notice} /> : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Scanning…" : "Scan back into stock"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Rider pickup
// ---------------------------------------------------------------------------

export function PickupForm({
  batchId,
  pending,
}: {
  batchId: string;
  pending: { assignmentId: string; trackingId: string }[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(pending.map((p) => p.trackingId)),
  );
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<{ trackingId: string; otpExpiresAt: string }[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  function toggle(trackingId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(trackingId)) next.delete(trackingId);
      else next.add(trackingId);
      return next;
    });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotes([]);
    const result = await confirmPickupAction(batchId, { trackingIds: [...selected] });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    sendTrackingEventUpdate();
    setCodes(result.data.taken.map((t) => ({ trackingId: t.trackingId, otpExpiresAt: t.otpExpiresAt })));
    const extra: string[] = [];
    if (result.data.shortages.length > 0) {
      extra.push(
        `Short at pickup (marked, left at warehouse): ${result.data.shortages.map((s) => s.trackingId).join(", ")}`,
      );
    }
    if (result.data.failed.length > 0) {
      extra.push(
        `Could not take: ${result.data.failed.map((f) => `${f.trackingId} (${f.reason})`).join("; ")}`,
      );
    }
    setNotes(extra);
    router.refresh();
  }

  if (pending.length === 0) return null;
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <p className="text-[13px] text-slate2">
        Tick every package you are physically taking. Anything unticked is recorded as a
        pickup shortage — never silently dropped.
      </p>
      <div className="grid gap-2">
        {pending.map((p) => (
          <label
            key={p.assignmentId}
            className="flex cursor-pointer items-center gap-3 rounded-md border border-line bg-page px-3 py-2"
          >
            <input
              type="checkbox"
              checked={selected.has(p.trackingId)}
              onChange={() => toggle(p.trackingId)}
            />
            <span className="font-mono text-[13px] font-semibold text-ink">{p.trackingId}</span>
          </label>
        ))}
      </div>
      {error ? <ErrorBox message={error} /> : null}
      {notes.map((n) => (
        <OkBox key={n} message={n} />
      ))}
      {codes !== null ? (
        <div className="rounded-md border border-line bg-page px-3 py-2">
          <p className="text-[13px] font-semibold text-ink">
            A delivery code was sent to each recipient — ask the recipient for their code
            at the door:
          </p>
          <ul className="mt-1 grid gap-1">
            {codes.map((c) => (
              <li key={c.trackingId} className="font-mono text-[13px] text-ink">
                {c.trackingId}: code sent to recipient (expires{" "}
                {new Date(c.otpExpiresAt).toLocaleTimeString()})
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Confirming…" : "Confirm pickup"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Rider vendor-pickup collection (PICKUP batches only)
// ---------------------------------------------------------------------------

export function PickupCollectionForm({
  batchId,
  pending,
}: {
  batchId: string;
  pending: { assignmentId: string; trackingId: string }[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(pending.map((p) => p.trackingId)),
  );
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  function toggle(trackingId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(trackingId)) next.delete(trackingId);
      else next.add(trackingId);
      return next;
    });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotes([]);
    const result = await confirmPickupCollectionAction(batchId, {
      trackingIds: [...selected],
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    sendTrackingEventUpdate();
    const extra: string[] = [];
    if (result.data.taken.length > 0) {
      extra.push(
        `Collected: ${result.data.taken.map((t) => t.trackingId).join(", ")} — bring them to the origin warehouse for the receiving scan.`,
      );
    }
    if (result.data.shortages.length > 0) {
      extra.push(
        `Not collected yet (still assigned to you): ${result.data.shortages.map((s) => s.trackingId).join(", ")}`,
      );
    }
    if (result.data.failed.length > 0) {
      extra.push(
        `Could not collect: ${result.data.failed.map((f) => `${f.trackingId} (${f.reason})`).join("; ")}`,
      );
    }
    setNotes(extra);
    router.refresh();
  }

  if (pending.length === 0) return null;
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <p className="text-[13px] text-slate2">
        Tick every package you are physically collecting from the sender. Anything unticked
        stays assigned to you as a shortage — never silently dropped.
      </p>
      <div className="grid gap-2">
        {pending.map((p) => (
          <label
            key={p.assignmentId}
            className="flex cursor-pointer items-center gap-3 rounded-md border border-line bg-page px-3 py-2"
          >
            <input
              type="checkbox"
              checked={selected.has(p.trackingId)}
              onChange={() => toggle(p.trackingId)}
            />
            <span className="font-mono text-[13px] font-semibold text-ink">{p.trackingId}</span>
          </label>
        ))}
      </div>
      {error ? <ErrorBox message={error} /> : null}
      {notes.map((n) => (
        <OkBox key={n} message={n} />
      ))}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Confirming…" : "Confirm collection"}
        </button>
      </div>
    </form>
  );
}

export function PickupFailedForm({ assignmentId }: { assignmentId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (reason.trim().length < 3) {
      setError("Give a short reason (at least 3 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await recordPickupAttemptAction(assignmentId, { reason: reason.trim() });
    setBusy(false);
    if (!res.success) {
      setError(res.error);
      return;
    }
    sendTrackingEventUpdate();
    setNotice("Pickup failure recorded — the warehouse will reschedule.");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={inputClass}
          placeholder="Pickup failed — reason (sender unavailable, not ready…)"
          aria-label="Pickup failure reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button type="submit" className={dangerButtonClass} disabled={busy}>
          {busy ? "Recording…" : "Pickup failed"}
        </button>
      </div>
      {error ? <span className="text-[12px] text-red">{error}</span> : null}
      {notice ? <OkBox message={notice} /> : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Rider attempt + delivery
// ---------------------------------------------------------------------------

const FAILED_RESULTS = DELIVERY_ATTEMPT_RESULTS.filter((r) => r !== "DELIVERED");

export function AttemptForm({ assignment }: { assignment: RiderAssignmentView }) {
  const router = useRouter();
  const [result, setResult] = useState<string>("RECIPIENT_UNAVAILABLE");
  const [failureReason, setFailureReason] = useState("");
  const [contactOutcome, setContactOutcome] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await recordDeliveryAttemptAction(assignment.id, {
      result: result as (typeof FAILED_RESULTS)[number],
      failureReason: failureReason.trim() || null,
      contactOutcome: (contactOutcome || null) as
        | (typeof DELIVERY_CONTACT_OUTCOMES)[number]
        | null,
      nextAction: (nextAction || null) as (typeof DELIVERY_NEXT_ACTIONS)[number] | null,
      notes: notes.trim() || null,
    });
    setBusy(false);
    if (!res.success) {
      setError(res.error);
      return;
    }
    sendTrackingEventUpdate();
    setNotice(
      res.data.returnRequest
        ? `Attempt ${res.data.attemptNumber} recorded. Return ${res.data.returnRequest.returnNumber} initiated — bring the package back to the warehouse.`
        : `Attempt ${res.data.attemptNumber} recorded (${res.data.failedAttempts} failed so far).`,
    );
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Attempt result">
          <select className={inputClass} value={result} onChange={(e) => setResult(e.target.value)}>
            {FAILED_RESULTS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Contact outcome (optional)">
          <select
            className={inputClass}
            value={contactOutcome}
            onChange={(e) => setContactOutcome(e.target.value)}
          >
            <option value="">—</option>
            {DELIVERY_CONTACT_OUTCOMES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Failure reason (optional)">
          <input
            className={inputClass}
            value={failureReason}
            onChange={(e) => setFailureReason(e.target.value)}
            placeholder="What happened at the door?"
          />
        </Field>
        <Field label="Next action (optional)">
          <select
            className={inputClass}
            value={nextAction}
            onChange={(e) => setNextAction(e.target.value)}
          >
            <option value="">Default for the result</option>
            {DELIVERY_NEXT_ACTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Notes (optional)">
          <input
            className={inputClass}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
      </div>
      {error ? <ErrorBox message={error} /> : null}
      {notice ? <OkBox message={notice} /> : null}
      <div>
        <button type="submit" className={subtleButtonClass} disabled={busy}>
          {busy ? "Recording…" : "Record failed attempt"}
        </button>
      </div>
    </form>
  );
}

export function DeliverForm({ assignment }: { assignment: RiderAssignmentView }) {
  const router = useRouter();
  const expected = BigInt(assignment.codExpectedPaisa);
  const [receivedByName, setReceivedByName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [codRupees, setCodRupees] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    let codCollectedPaisa: string | null = null;
    if (expected > BigInt(0)) {
      const rupees = Number(codRupees);
      if (!Number.isFinite(rupees) || rupees < 0) {
        setBusy(false);
        setError("Enter the COD amount collected, in rupees.");
        return;
      }
      codCollectedPaisa = String(Math.round(rupees * 100));
    }
    const res = await confirmDeliveryAction(assignment.id, {
      receivedByName: receivedByName.trim(),
      relationshipToRecipient: relationship.trim() || null,
      otpCode: otpCode.trim(),
      codCollectedPaisa,
      notes: notes.trim() || null,
    });
    setBusy(false);
    if (!res.success) {
      setError(res.error);
      return;
    }
    sendTrackingEventUpdate();
    setNotice(
      res.data.cod
        ? `Delivered. COD ${res.data.cod.status}: collected ${formatPaisa(BigInt(res.data.cod.collectedPaisa))} of ${formatPaisa(BigInt(res.data.cod.expectedPaisa))}.`
        : "Delivered — proof of delivery recorded.",
    );
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Received by (name)">
          <input
            className={inputClass}
            value={receivedByName}
            onChange={(e) => setReceivedByName(e.target.value)}
            required
          />
        </Field>
        <Field label="Relationship to recipient (optional)">
          <input
            className={inputClass}
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
            placeholder="Self, family, guard…"
          />
        </Field>
        <Field label="Delivery code (6 digits from the recipient)">
          <input
            className={inputClass}
            value={otpCode}
            onChange={(e) => setOtpCode(e.target.value)}
            inputMode="numeric"
            maxLength={6}
            required
          />
        </Field>
        {expected > BigInt(0) ? (
          <Field label={`COD collected (NPR) — due ${formatPaisa(expected)}`}>
            <input
              className={inputClass}
              type="number"
              min="0"
              step="0.01"
              value={codRupees}
              onChange={(e) => setCodRupees(e.target.value)}
              required
            />
          </Field>
        ) : null}
        <Field label="Notes (required when the COD amount differs)">
          <input
            className={inputClass}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
      </div>
      {assignment.otpState.locked ? (
        <ErrorBox message="The delivery code is locked after too many wrong entries — request a new code below." />
      ) : null}
      {error ? <ErrorBox message={error} /> : null}
      {notice ? <OkBox message={notice} /> : null}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Confirming…" : "Confirm delivery"}
        </button>
        <RegenerateOtpButton assignmentId={assignment.id} />
      </div>
    </form>
  );
}

export function RegenerateOtpButton({ assignmentId }: { assignmentId: string }) {
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    setError(null);
    const res = await regenerateOtpAction(assignmentId);
    setBusy(false);
    if (!res.success) {
      setError(res.error);
      return;
    }
    setSent(res.data.expiresAt);
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className={subtleButtonClass} disabled={busy} onClick={onClick}>
        {busy ? "Issuing…" : "New delivery code"}
      </button>
      {sent ? (
        <span className="text-[13px] text-ink">
          New code sent to the recipient (expires {new Date(sent).toLocaleTimeString()}) —
          ask them for it at the door.
        </span>
      ) : null}
      {error ? <span className="text-[12px] text-red">{error}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

export function InitiateReturnForm({ packageId }: { packageId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState<string>("RECIPIENT_REFUSED");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await initiateReturnAction({
      packageId,
      reason: reason as (typeof RETURN_REASONS)[number],
      notes: notes.trim() || null,
    });
    setBusy(false);
    if (!res.success) {
      setError(res.error);
      return;
    }
    setNotice(`Return ${res.data.returnNumber} opened (status ${res.data.status}).`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Return reason">
          <select className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)}>
            {RETURN_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Notes (optional)">
          <input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      {error ? <ErrorBox message={error} /> : null}
      {notice ? <OkBox message={notice} /> : null}
      <div>
        <button type="submit" className={subtleButtonClass} disabled={busy}>
          {busy ? "Opening…" : "Open return"}
        </button>
      </div>
    </form>
  );
}

export function ApproveReturnForm({ returnId }: { returnId: string }) {
  const router = useRouter();
  const [chargeBearer, setChargeBearer] = useState<string>("VENDOR");
  const [chargeRupees, setChargeRupees] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const rupees = Number(chargeRupees);
    const res = await approveReturnAction(returnId, {
      chargeBearer: chargeBearer as (typeof RETURN_CHARGE_BEARERS)[number],
      chargeAmountPaisa: Number.isFinite(rupees) ? String(Math.round(rupees * 100)) : "0",
    });
    setBusy(false);
    if (!res.success) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
      <Field label="Return charges borne by">
        <select
          className={inputClass}
          value={chargeBearer}
          onChange={(e) => setChargeBearer(e.target.value)}
        >
          {RETURN_CHARGE_BEARERS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Charge amount (NPR)">
        <input
          className={inputClass}
          type="number"
          min="0"
          step="0.01"
          value={chargeRupees}
          onChange={(e) => setChargeRupees(e.target.value)}
        />
      </Field>
      <button type="submit" className={primaryButtonClass} disabled={busy}>
        {busy ? "Approving…" : "Approve return"}
      </button>
      {error ? <ErrorBox message={error} /> : null}
    </form>
  );
}

export function RejectReturnForm({ returnId }: { returnId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const res = await rejectReturnAction(returnId, { reason: reason.trim() });
    setBusy(false);
    if (!res.success) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
      <Field label="Rejection reason">
        <input
          className={inputClass}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
      </Field>
      <button type="submit" className={dangerButtonClass} disabled={busy}>
        {busy ? "Rejecting…" : "Reject return"}
      </button>
      {error ? <ErrorBox message={error} /> : null}
    </form>
  );
}

export function InspectReturnForm({ returnId }: { returnId: string }) {
  const router = useRouter();
  const [condition, setCondition] = useState<string>("GOOD");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const res = await inspectReturnAction(returnId, {
      condition: condition as (typeof PACKAGE_CONDITIONS)[number],
      notes: notes.trim() || null,
    });
    setBusy(false);
    if (!res.success) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
      <Field label="Condition at inspection">
        <select
          className={inputClass}
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
        >
          {PACKAGE_CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Notes (optional)">
        <input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <button type="submit" className={primaryButtonClass} disabled={busy}>
        {busy ? "Saving…" : "Record inspection"}
      </button>
      {error ? <ErrorBox message={error} /> : null}
    </form>
  );
}

export function CompleteReturnButton({ returnId }: { returnId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    setError(null);
    const res = await completeReturnAction(returnId, {});
    setBusy(false);
    if (!res.success) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className={primaryButtonClass} disabled={busy} onClick={onClick}>
        {busy ? "Completing…" : "Complete return — hand to vendor"}
      </button>
      {error ? <span className="text-[12px] text-red">{error}</span> : null}
    </span>
  );
}
