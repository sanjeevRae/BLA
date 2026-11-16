"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import {
  addTransferItemsAction,
  approveTransferAction,
  assignTransferCrewAction,
  cancelTransferAction,
  closeTransferAction,
  completePackageReceivingAction,
  createTransferAction,
  dispatchTransferAction,
  finishReceivingAction,
  generateManifestAction,
  loadTransferPackageAction,
  reconcileTransferAction,
  rejectTransferAction,
  removeTransferItemAction,
  reviseTransferAction,
  scanDestinationPackageAction,
  submitTransferAction,
  unloadTransferPackageAction,
  arriveTripAction,
  departTripAction,
  recordCheckpointAction,
  replaceTripDriverAction,
  reportTripDelayAction,
  resumeTripAction,
} from "@/server/actions/transfers";
import { PACKAGE_CONDITIONS } from "@/lib/bookings/domain";
import { sendTrackingEventUpdate } from "@/lib/tracking/client-registry";
import {
  ErrorBox,
  inputClass,
  labelClass,
  primaryButtonClass,
  subtleButtonClass,
  dangerButtonClass,
} from "@/components/warehouses/ui";
import type { OpsPackageSummary } from "@/server/services/inventory";

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
// Create transfer
// ---------------------------------------------------------------------------

export function CreateTransferForm({
  origin,
  destinations,
  basePath,
}: {
  origin: WarehouseOption;
  destinations: WarehouseOption[];
  basePath: string;
}) {
  const router = useRouter();
  const [destinationWarehouseId, setDestinationWarehouseId] = useState("");
  const [expectedArrivalAt, setExpectedArrivalAt] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await createTransferAction({
      originWarehouseId: origin.id,
      destinationWarehouseId,
      expectedArrivalAt: expectedArrivalAt
        ? new Date(expectedArrivalAt).toISOString()
        : null,
      instructions: instructions.trim() || null,
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    router.push(`${basePath}/transfers/${result.data.id}`);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Origin warehouse">
          <input className={inputClass} value={`${origin.name} (${origin.code})`} disabled />
        </Field>
        <Field label="Destination warehouse">
          <select
            className={inputClass}
            value={destinationWarehouseId}
            onChange={(e) => setDestinationWarehouseId(e.target.value)}
            required
          >
            <option value="">Select destination…</option>
            {destinations.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.code})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Expected arrival (optional)">
          <input
            className={inputClass}
            type="datetime-local"
            value={expectedArrivalAt}
            onChange={(e) => setExpectedArrivalAt(e.target.value)}
          />
        </Field>
        <Field label="Instructions (optional)">
          <input
            className={inputClass}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Handling notes for the crew"
          />
        </Field>
      </div>
      {error ? <ErrorBox message={error} /> : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Creating…" : "Create draft transfer"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Add / remove items
// ---------------------------------------------------------------------------

export function AddItemsForm({
  transferId,
  eligible,
}: {
  transferId: string;
  eligible: OpsPackageSummary[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    setMessage(null);
    const result = await addTransferItemsAction(transferId, [...selected]);
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    const parts = [`${result.data.added.length} package(s) added.`];
    if (result.data.rejected.length > 0) {
      parts.push(
        result.data.rejected
          .map((r) => `${r.trackingId ?? r.packageId}: ${r.reason}`)
          .join(" · "),
      );
    }
    setMessage(parts.join(" "));
    setSelected(new Set());
    router.refresh();
  }

  if (eligible.length === 0) {
    return (
      <p className="text-[13px] text-slate2">
        No packages are currently READY_FOR_DISPATCH at this warehouse for that
        destination.
      </p>
    );
  }
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="max-h-64 overflow-auto rounded-md border border-line">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-line text-slate2">
              <th className="px-3 py-2"></th>
              <th className="px-3 py-2">Tracking ID</th>
              <th className="px-3 py-2">Recipient</th>
              <th className="px-3 py-2">District</th>
              <th className="px-3 py-2">Weight</th>
            </tr>
          </thead>
          <tbody>
            {eligible.map((pkg) => (
              <tr key={pkg.id} className="border-b border-line last:border-0">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(pkg.id)}
                    onChange={() => toggle(pkg.id)}
                  />
                </td>
                <td className="px-3 py-2 font-mono">{pkg.trackingId}</td>
                <td className="px-3 py-2">{pkg.recipientName}</td>
                <td className="px-3 py-2">{pkg.deliveryDistrict}</td>
                <td className="px-3 py-2">
                  {pkg.billableWeightKg ?? pkg.actualWeightKg ?? pkg.declaredWeightKg} kg
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {message ? <OkBox message={message} /> : null}
      {error ? <ErrorBox message={error} /> : null}
      <div>
        <button
          type="submit"
          className={primaryButtonClass}
          disabled={busy || selected.size === 0}
        >
          {busy ? "Adding…" : `Add ${selected.size} selected package(s)`}
        </button>
      </div>
    </form>
  );
}

export function RemoveItemButton({
  transferId,
  packageId,
  trackingId,
}: {
  transferId: string;
  packageId: string;
  trackingId: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onRemove() {
    const reason = window.prompt(`Reason for removing ${trackingId} from this transfer?`);
    if (reason === null) return;
    setBusy(true);
    setError(null);
    const result = await removeTransferItemAction(transferId, packageId, reason || undefined);
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button type="button" className={dangerButtonClass} disabled={busy} onClick={onRemove}>
        Remove
      </button>
      {error ? <span className="text-[12px] text-red-700">{error}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Lifecycle buttons (submit / approve / reject / revise / cancel / manifest)
// ---------------------------------------------------------------------------

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<{ success: boolean; error?: string }>) {
    setBusy(true);
    setError(null);
    const result = await fn();
    setBusy(false);
    if (!result.success) {
      setError(result.error ?? "Action failed");
      return;
    }
    router.refresh();
  }
  return { error, busy, run };
}

export function TransferLifecycleButtons({
  transferId,
  status,
  canCreate,
  canApprove,
}: {
  transferId: string;
  status: string;
  canCreate: boolean;
  canApprove: boolean;
}) {
  const { error, busy, run } = useAction();
  const buttons: ReactNode[] = [];

  if (canCreate && (status === "DRAFT" || status === "PREPARING")) {
    buttons.push(
      <button
        key="submit"
        type="button"
        className={subtleButtonClass}
        disabled={busy}
        onClick={() => run(() => submitTransferAction(transferId))}
      >
        Submit for approval
      </button>,
    );
  }
  if (canApprove && status === "REQUESTED") {
    buttons.push(
      <button
        key="approve"
        type="button"
        className={primaryButtonClass}
        disabled={busy}
        onClick={() => run(() => approveTransferAction(transferId))}
      >
        Approve
      </button>,
      <button
        key="reject"
        type="button"
        className={dangerButtonClass}
        disabled={busy}
        onClick={() => {
          const reason = window.prompt("Reason for rejecting this transfer?");
          if (reason) run(() => rejectTransferAction(transferId, reason));
        }}
      >
        Reject
      </button>,
    );
  }
  if (canCreate && status === "REJECTED") {
    buttons.push(
      <button
        key="revise"
        type="button"
        className={subtleButtonClass}
        disabled={busy}
        onClick={() => run(() => reviseTransferAction(transferId))}
      >
        Revise (back to draft)
      </button>,
    );
  }
  if (
    canCreate &&
    ["DRAFT", "PREPARING", "REQUESTED", "APPROVED", "REJECTED", "READY_FOR_DISPATCH"].includes(status)
  ) {
    buttons.push(
      <button
        key="cancel"
        type="button"
        className={dangerButtonClass}
        disabled={busy}
        onClick={() => {
          const reason = window.prompt("Reason for cancelling this transfer?");
          if (reason !== null) run(() => cancelTransferAction(transferId, reason || undefined));
        }}
      >
        Cancel transfer
      </button>,
    );
  }
  if (buttons.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">{buttons}</div>
      {error ? <ErrorBox message={error} /> : null}
    </div>
  );
}

export function GenerateManifestButton({ transferId }: { transferId: string }) {
  const { error, busy, run } = useAction();
  return (
    <div className="flex flex-col gap-2">
      <div>
        <button
          type="button"
          className={primaryButtonClass}
          disabled={busy}
          onClick={() => run(() => generateManifestAction(transferId))}
        >
          {busy ? "Generating…" : "Generate manifest"}
        </button>
      </div>
      <p className="text-[12px] text-slate2">
        Generating the manifest freezes the package set onto the transfer and moves every
        package to TRANSFER_ASSIGNED. It can only be generated once.
      </p>
      {error ? <ErrorBox message={error} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Crew assignment
// ---------------------------------------------------------------------------

export interface CrewDriverOption {
  driverId: string;
  name: string;
  blockers: string[];
}
export interface CrewVehicleOption {
  vehicleId: string;
  registration: string;
  blockers: string[];
}

export function AssignCrewForm({
  transferId,
  drivers,
  vehicles,
  currentDriverId,
  currentVehicleId,
}: {
  transferId: string;
  drivers: CrewDriverOption[];
  vehicles: CrewVehicleOption[];
  currentDriverId: string | null;
  currentVehicleId: string | null;
}) {
  const router = useRouter();
  const [driverId, setDriverId] = useState(currentDriverId ?? "");
  const [vehicleId, setVehicleId] = useState(currentVehicleId ?? "");
  const [plannedDepartureAt, setPlannedDepartureAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await assignTransferCrewAction({
      transferId,
      driverId,
      vehicleId,
      plannedDepartureAt: plannedDepartureAt
        ? new Date(plannedDepartureAt).toISOString()
        : null,
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Line-haul driver">
          <select
            className={inputClass}
            value={driverId}
            onChange={(e) => setDriverId(e.target.value)}
            required
          >
            <option value="">Select driver…</option>
            {drivers.map((d) => (
              <option key={d.driverId} value={d.driverId} disabled={d.blockers.length > 0}>
                {d.name}
                {d.blockers.length > 0 ? ` — ${d.blockers.join("; ")}` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Vehicle">
          <select
            className={inputClass}
            value={vehicleId}
            onChange={(e) => setVehicleId(e.target.value)}
            required
          >
            <option value="">Select vehicle…</option>
            {vehicles.map((v) => (
              <option key={v.vehicleId} value={v.vehicleId} disabled={v.blockers.length > 0}>
                {v.registration}
                {v.blockers.length > 0 ? ` — ${v.blockers.join("; ")}` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Planned departure (optional)">
          <input
            className={inputClass}
            type="datetime-local"
            value={plannedDepartureAt}
            onChange={(e) => setPlannedDepartureAt(e.target.value)}
          />
        </Field>
      </div>
      {error ? <ErrorBox message={error} /> : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Assigning…" : "Assign crew"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Loading + dispatch
// ---------------------------------------------------------------------------

export function LoadScanForm({ transferId }: { transferId: string }) {
  const router = useRouter();
  const [trackingId, setTrackingId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    const result = await loadTransferPackageAction(
      transferId,
      trackingId.trim(),
      `load-${transferId}-${trackingId.trim()}`,
    );
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setMessage(
      result.data.alreadyScanned
        ? `${result.data.trackingId} was already loaded — duplicate scan ignored.`
        : `${result.data.trackingId} loaded.`,
    );
    setTrackingId("");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          className={inputClass}
          value={trackingId}
          onChange={(e) => setTrackingId(e.target.value)}
          placeholder="Scan or type tracking ID"
          required
        />
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Loading…" : "Load"}
        </button>
      </div>
      {message ? <OkBox message={message} /> : null}
      {error ? <ErrorBox message={error} /> : null}
    </form>
  );
}

export function UnloadButton({
  transferId,
  trackingId,
}: {
  transferId: string;
  trackingId: string;
}) {
  const { error, busy, run } = useAction();
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        className={subtleButtonClass}
        disabled={busy}
        onClick={() => run(() => unloadTransferPackageAction(transferId, trackingId))}
      >
        Unload
      </button>
      {error ? <span className="text-[12px] text-red-700">{error}</span> : null}
    </span>
  );
}

export function DispatchButton({
  transferId,
  loadedCount,
  totalCount,
}: {
  transferId: string;
  loadedCount: number;
  totalCount: number;
}) {
  const { error, busy, run } = useAction();
  const allLoaded = totalCount > 0 && loadedCount === totalCount;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          className={primaryButtonClass}
          disabled={busy || !allLoaded}
          onClick={() => run(() => dispatchTransferAction(transferId))}
        >
          {busy ? "Dispatching…" : "Dispatch transfer"}
        </button>
        <span className="text-[13px] text-slate2">
          {loadedCount}/{totalCount} packages loaded
          {!allLoaded ? " — dispatch unlocks when every manifested package is scanned on." : ""}
        </span>
      </div>
      {error ? <ErrorBox message={error} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Destination receiving
// ---------------------------------------------------------------------------

export function DestinationScanForm({ transferId }: { transferId: string }) {
  const router = useRouter();
  const [trackingId, setTrackingId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    const result = await scanDestinationPackageAction(transferId, {
      trackingId: trackingId.trim(),
      idempotencyKey: `unload-${transferId}-${trackingId.trim()}`,
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    if (result.data.kind === "WRONG_PACKAGE") {
      setMessage(
        `${result.data.trackingId}: WRONG WAREHOUSE — flagged MISROUTED and NOT stocked here.`,
      );
    } else if (result.data.kind === "EXCESS") {
      setMessage(
        `${result.data.trackingId}: not on this manifest (excess arrival) — observation recorded, NOT stocked by this scan.`,
      );
    } else if (result.data.alreadyReceived) {
      setMessage(`${result.data.trackingId} was already received — duplicate scan ignored.`);
    } else {
      setMessage(`${result.data.trackingId} received into destination inspection.`);
    }
    setTrackingId("");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          className={inputClass}
          value={trackingId}
          onChange={(e) => setTrackingId(e.target.value)}
          placeholder="Scan or type tracking ID"
          required
        />
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Scanning…" : "Receive scan"}
        </button>
      </div>
      {message ? <OkBox message={message} /> : null}
      {error ? <ErrorBox message={error} /> : null}
    </form>
  );
}

export function CompleteReceivingForm({
  transferId,
  packageId,
  trackingId,
}: {
  transferId: string;
  packageId: string;
  trackingId: string;
}) {
  const router = useRouter();
  const [condition, setCondition] = useState<(typeof PACKAGE_CONDITIONS)[number]>("GOOD");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await completePackageReceivingAction(
      transferId,
      packageId,
      condition,
      notes.trim() || undefined,
    );
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
      <Field label={`Condition — ${trackingId}`}>
        <select
          className={inputClass}
          value={condition}
          onChange={(e) => setCondition(e.target.value as (typeof PACKAGE_CONDITIONS)[number])}
        >
          {PACKAGE_CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Notes (optional)">
        <input
          className={inputClass}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Damage details"
        />
      </Field>
      <button type="submit" className={subtleButtonClass} disabled={busy}>
        {busy ? "Saving…" : "Complete receiving"}
      </button>
      {error ? <ErrorBox message={error} /> : null}
    </form>
  );
}

export function ReceivingCloseButtons({
  transferId,
  status,
  canReconcile,
}: {
  transferId: string;
  status: string;
  canReconcile: boolean;
}) {
  const { error, busy, run } = useAction();
  const buttons: ReactNode[] = [];
  if (["ARRIVED", "PARTIALLY_RECEIVED", "RECEIVED", "EXCEPTION"].includes(status)) {
    buttons.push(
      <button
        key="finish"
        type="button"
        className={subtleButtonClass}
        disabled={busy}
        onClick={() => run(() => finishReceivingAction(transferId))}
      >
        Finish receiving (unreceived = missing)
      </button>,
    );
  }
  if (canReconcile && status === "RECONCILIATION_PENDING") {
    buttons.push(
      <button
        key="reconcile"
        type="button"
        className={primaryButtonClass}
        disabled={busy}
        onClick={() => run(() => reconcileTransferAction(transferId))}
      >
        Reconcile transfer
      </button>,
    );
  }
  if (canReconcile && status === "EXCEPTION") {
    buttons.push(
      <button
        key="reconcile2"
        type="button"
        className={primaryButtonClass}
        disabled={busy}
        onClick={() => run(() => finishReceivingAction(transferId))}
      >
        Re-check after late arrivals
      </button>,
    );
  }
  if (canReconcile && status === "RECONCILED") {
    buttons.push(
      <button
        key="close"
        type="button"
        className={primaryButtonClass}
        disabled={busy}
        onClick={() => run(() => closeTransferAction(transferId))}
      >
        Close transfer
      </button>,
    );
  }
  if (buttons.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">{buttons}</div>
      {error ? <ErrorBox message={error} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// En-route driver replacement (shown only while the trip is en route)
// ---------------------------------------------------------------------------

export function ReplaceDriverForm({
  tripId,
  status,
  drivers,
  currentDriverId,
}: {
  tripId: string;
  status: string;
  drivers: CrewDriverOption[];
  currentDriverId: string;
}) {
  const router = useRouter();
  const [driverId, setDriverId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!["DISPATCHED", "IN_TRANSIT", "DELAYED", "INCIDENT"].includes(status)) return null;

  async function onClick() {
    if (!driverId) {
      setError("Select the replacement driver.");
      return;
    }
    if (reason.trim().length < 3) {
      setError("Give a short reason (at least 3 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await replaceTripDriverAction(tripId, {
      driverId,
      reason: reason.trim(),
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={inputClass}
          value={driverId}
          onChange={(e) => setDriverId(e.target.value)}
        >
          <option value="">Replace driver with…</option>
          {drivers
            .filter((d) => d.driverId !== currentDriverId)
            .map((d) => (
              <option key={d.driverId} value={d.driverId} disabled={d.blockers.length > 0}>
                {d.name}
                {d.blockers.length > 0 ? ` — ${d.blockers.join("; ")}` : ""}
              </option>
            ))}
        </select>
        <input
          className={inputClass}
          placeholder="Reason (required)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button type="button" className={subtleButtonClass} disabled={busy} onClick={onClick}>
          {busy ? "Replacing…" : "Replace driver"}
        </button>
      </div>
      <p className="text-[12px] text-slate2">
        En-route replacement: package custody and the trip move to the new driver; the
        current driver&apos;s tracking session ends.
      </p>
      {error ? <ErrorBox message={error} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trip progress (driver + oversight)
// ---------------------------------------------------------------------------

export function TripProgressForms({ tripId, status }: { tripId: string; status: string }) {
  const { error, busy, run } = useAction();
  const [checkpoint, setCheckpoint] = useState("");
  const [delayReason, setDelayReason] = useState("");
  const [revisedEta, setRevisedEta] = useState("");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {status === "DISPATCHED" ? (
          <button
            type="button"
            className={primaryButtonClass}
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await departTripAction(tripId);
                if (r.success) sendTrackingEventUpdate();
                return r;
              })
            }
          >
            Record departure
          </button>
        ) : null}
        {status === "IN_TRANSIT" || status === "DELAYED" ? (
          <button
            type="button"
            className={primaryButtonClass}
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await arriveTripAction(tripId);
                if (r.success) sendTrackingEventUpdate();
                return r;
              })
            }
          >
            Record arrival at destination
          </button>
        ) : null}
        {status === "DELAYED" ? (
          <button
            type="button"
            className={subtleButtonClass}
            disabled={busy}
            onClick={() => run(() => resumeTripAction(tripId))}
          >
            Resume trip
          </button>
        ) : null}
      </div>

      {status === "IN_TRANSIT" || status === "DELAYED" ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (checkpoint.trim()) {
              run(async () => {
                const r = await recordCheckpointAction(tripId, { label: checkpoint.trim() });
                if (r.success) setCheckpoint("");
                return r;
              });
            }
          }}
        >
          <Field label="Checkpoint">
            <input
              className={inputClass}
              value={checkpoint}
              onChange={(e) => setCheckpoint(e.target.value)}
              placeholder="e.g. Mugling bazaar"
            />
          </Field>
          <button type="submit" className={subtleButtonClass} disabled={busy}>
            Add checkpoint
          </button>
        </form>
      ) : null}

      {status === "IN_TRANSIT" ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (delayReason.trim()) {
              run(async () => {
                const r = await reportTripDelayAction(tripId, {
                  reason: delayReason.trim(),
                  revisedExpectedArrivalAt: revisedEta
                    ? new Date(revisedEta).toISOString()
                    : null,
                });
                if (r.success) {
                  setDelayReason("");
                  setRevisedEta("");
                }
                return r;
              });
            }
          }}
        >
          <Field label="Delay reason">
            <input
              className={inputClass}
              value={delayReason}
              onChange={(e) => setDelayReason(e.target.value)}
              placeholder="e.g. Landslide near Naubise"
            />
          </Field>
          <Field label="Revised ETA (optional)">
            <input
              className={inputClass}
              type="datetime-local"
              value={revisedEta}
              onChange={(e) => setRevisedEta(e.target.value)}
            />
          </Field>
          <button type="submit" className={dangerButtonClass} disabled={busy}>
            Report delay
          </button>
        </form>
      ) : null}

      {error ? <ErrorBox message={error} /> : null}
    </div>
  );
}
