"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import {
  closeHandoverBatchAction,
  confirmHandoverAction,
  createStockItemAction,
  initiateHandoverAction,
  markReadyForDispatchAction,
  moveInternalAction,
  moveToInspectionAction,
  previewReceivingAction,
  putAwayPackageAction,
  receivePackageAction,
  recordInspectionAction,
  recordStockMovementAction,
  startInspectionAction,
  updateStockItemAction,
} from "@/server/actions/warehouse-ops";
import {
  ErrorBox,
  inputClass,
  labelClass,
  primaryButtonClass,
  subtleButtonClass,
} from "@/components/warehouses/ui";
import type { previewReceiving } from "@/server/services/inventory";

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

export interface LocationOption {
  id: string;
  fullCode: string;
  zoneKind: string;
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

type PreviewState = Awaited<ReturnType<typeof previewReceiving>>;

export function ReceivingForm({ warehouseId }: { warehouseId: string }) {
  const router = useRouter();
  const [trackingId, setTrackingId] = useState("");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onLookup(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    setPreview(null);
    const result = await previewReceivingAction(warehouseId, trackingId.trim());
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    if (!result.data.found) {
      setError(`No package found with tracking ID ${trackingId.trim()}`);
      return;
    }
    setPreview(result.data);
  }

  async function onReceive() {
    setBusy(true);
    setError(null);
    const result = await receivePackageAction({
      warehouseId,
      trackingId: trackingId.trim(),
      // Deterministic per parcel+warehouse: resubmitting the same scan
      // replays the same key, so a duplicate scan can never duplicate.
      idempotencyKey: `scan-${warehouseId}-${trackingId.trim()}`,
      source: "WEB",
      capacityOverrideReason: overrideReason.trim() || null,
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    const data = result.data;
    if (data.misrouted) {
      setMessage(
        `Misrouted arrival recorded for ${data.package.trackingId} — it was NOT stocked here. An exception was raised on the parcel's history.`,
      );
    } else if (data.alreadyReceived) {
      setMessage(
        `${data.package.trackingId} was already received — this scan returned the existing record and wrote nothing new.`,
      );
    } else {
      setMessage(
        `${data.package.trackingId} received into inventory.` +
          (data.capacityWarning
            ? ` Warehouse capacity is at ${data.capacityWarning.toLowerCase()} level.`
            : "") +
          (data.capacityOverrideUsed ? " A capacity override was used and audited." : ""),
      );
    }
    setPreview(null);
    setTrackingId("");
    setOverrideReason("");
    router.refresh();
  }

  return (
    <div className="grid gap-3">
      <form onSubmit={onLookup} className="flex flex-wrap items-end gap-2">
        <div className="min-w-[260px] flex-1">
          <Field label="Tracking ID">
            <input
              className={inputClass}
              value={trackingId}
              onChange={(e) => setTrackingId(e.target.value)}
              placeholder="BLA-…"
              required
            />
          </Field>
        </div>
        <button type="submit" className={subtleButtonClass} disabled={busy}>
          Look up
        </button>
      </form>
      {error ? <ErrorBox message={error} /> : null}
      {message ? <OkBox message={message} /> : null}
      {preview?.package ? (
        <div className="rounded-md border border-line px-3 py-2 text-[13px] text-ink">
          <div className="font-mono font-semibold">{preview.package.trackingId}</div>
          <div className="mt-1 text-slate2">
            {preview.package.recipientName} · {preview.package.deliveryDistrict} · status{" "}
            <strong className="text-ink">{preview.package.operationalStatus}</strong> ·
            declared {preview.package.declaredWeightKg} kg
          </div>
          {preview.state === "MISROUTE_WARNING" ? (
            <p className="mt-1 text-orange">
              This parcel belongs to a different origin warehouse. Confirming will record a
              misrouted arrival (exception + audit) — the parcel will NOT be stocked here.
            </p>
          ) : null}
          {preview.state === "ALREADY_RECEIVED_HERE" ? (
            <p className="mt-1 text-slate2">Already in stock at this warehouse.</p>
          ) : null}
          {preview.state === "STOCKED_ELSEWHERE" ? (
            <p className="mt-1 text-red">Already in stock at another warehouse.</p>
          ) : null}
          {preview.state === "NOT_RECEIVABLE" ? (
            <p className="mt-1 text-red">
              This parcel is in status {preview.package.operationalStatus} and cannot be
              received at origin.
            </p>
          ) : null}
          {preview.state === "RECEIVABLE" || preview.state === "MISROUTE_WARNING" ? (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div className="min-w-[220px] flex-1">
                <Field label="Capacity override reason (only if the warehouse is full)">
                  <input
                    className={inputClass}
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder="Optional — Admin/Super Admin only"
                  />
                </Field>
              </div>
              <button
                type="button"
                className={primaryButtonClass}
                disabled={busy}
                onClick={onReceive}
              >
                {preview.state === "MISROUTE_WARNING"
                  ? "Record misrouted arrival"
                  : "Confirm receiving"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspection + sorting row actions
// ---------------------------------------------------------------------------

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run<T>(fn: () => Promise<{ success: boolean; error?: string; data?: T }>) {
    setBusy(true);
    setError(null);
    const result = await fn();
    setBusy(false);
    if (!result.success) {
      setError(result.error ?? "Action failed");
      return null;
    }
    router.refresh();
    return result.data ?? null;
  }
  return { error, busy, run };
}

export function MoveToInspectionButton({ packageId }: { packageId: string }) {
  const { error, busy, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={subtleButtonClass}
        disabled={busy}
        onClick={() => void run(() => moveToInspectionAction(packageId))}
      >
        Move to inspection
      </button>
      {error ? <span className="text-[12px] text-red">{error}</span> : null}
    </span>
  );
}

export function StartInspectionButton({ packageId }: { packageId: string }) {
  const { error, busy, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={subtleButtonClass}
        disabled={busy}
        onClick={() => void run(() => startInspectionAction(packageId))}
      >
        Start inspection
      </button>
      {error ? <span className="text-[12px] text-red">{error}</span> : null}
    </span>
  );
}

export function InspectionRecordForm({ packageId }: { packageId: string }) {
  const { error, busy, run } = useAction();
  const [condition, setCondition] = useState("GOOD");
  const [weight, setWeight] = useState("");
  const [length, setLength] = useState("");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [notes, setNotes] = useState("");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await run(() =>
      recordInspectionAction({
        packageId,
        condition: condition as "GOOD" | "DAMAGED" | "SUSPECTED_DAMAGE" | "PACKAGING_COMPROMISED",
        actualWeightKg: weight ? Number(weight) : null,
        lengthCm: length ? Number(length) : null,
        widthCm: width ? Number(width) : null,
        heightCm: height ? Number(height) : null,
        notes: notes.trim() || null,
      }),
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <div className="w-[170px]">
          <Field label="Condition">
            <select
              className={inputClass}
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
            >
              <option value="GOOD">Good</option>
              <option value="DAMAGED">Damaged</option>
              <option value="SUSPECTED_DAMAGE">Suspected damage</option>
              <option value="PACKAGING_COMPROMISED">Packaging compromised</option>
            </select>
          </Field>
        </div>
        <div className="w-[110px]">
          <Field label="Actual kg">
            <input
              className={inputClass}
              type="number"
              step="0.001"
              min="0"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
            />
          </Field>
        </div>
        <div className="w-[90px]">
          <Field label="L cm">
            <input
              className={inputClass}
              type="number"
              step="0.1"
              min="0"
              value={length}
              onChange={(e) => setLength(e.target.value)}
            />
          </Field>
        </div>
        <div className="w-[90px]">
          <Field label="W cm">
            <input
              className={inputClass}
              type="number"
              step="0.1"
              min="0"
              value={width}
              onChange={(e) => setWidth(e.target.value)}
            />
          </Field>
        </div>
        <div className="w-[90px]">
          <Field label="H cm">
            <input
              className={inputClass}
              type="number"
              step="0.1"
              min="0"
              value={height}
              onChange={(e) => setHeight(e.target.value)}
            />
          </Field>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[200px] flex-1">
          <Field label="Notes">
            <input
              className={inputClass}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Damage detail, repacking, …"
            />
          </Field>
        </div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          Record inspection
        </button>
      </div>
      {condition === "DAMAGED" ? (
        <p className="text-[12px] text-orange">
          Recording damage sets the parcel&rsquo;s exception and moves it to the
          damaged/quarantine zone.
        </p>
      ) : null}
      {error ? <ErrorBox message={error} /> : null}
    </form>
  );
}

export function PutAwayForm({
  packageId,
  locations,
}: {
  packageId: string;
  locations: LocationOption[];
}) {
  const { error, busy, run } = useAction();
  const [locationId, setLocationId] = useState("");
  const usable = locations.filter((l) => l.zoneKind !== "DAMAGED");
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <select
        className={`${inputClass} w-[220px]`}
        value={locationId}
        onChange={(e) => setLocationId(e.target.value)}
        aria-label="Storage location"
      >
        <option value="">Storage location…</option>
        {usable.map((l) => (
          <option key={l.id} value={l.id}>
            {l.fullCode} ({l.zoneKind.toLowerCase()})
          </option>
        ))}
      </select>
      <button
        type="button"
        className={subtleButtonClass}
        disabled={busy || !locationId}
        onClick={() => void run(() => putAwayPackageAction(packageId, locationId))}
      >
        Put away (mark sorted)
      </button>
      {error ? <span className="text-[12px] text-red">{error}</span> : null}
    </span>
  );
}

export function MoveInternalForm({
  packageId,
  locations,
  currentLocationId,
}: {
  packageId: string;
  locations: LocationOption[];
  currentLocationId: string | null;
}) {
  const { error, busy, run } = useAction();
  const [locationId, setLocationId] = useState("");
  const [reason, setReason] = useState("");
  const [correction, setCorrection] = useState(false);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <select
        className={`${inputClass} w-[200px]`}
        value={locationId}
        onChange={(e) => setLocationId(e.target.value)}
        aria-label="Move to location"
      >
        <option value="">Move to…</option>
        {locations
          .filter((l) => l.id !== currentLocationId)
          .map((l) => (
            <option key={l.id} value={l.id}>
              {l.fullCode} ({l.zoneKind.toLowerCase()})
            </option>
          ))}
      </select>
      <input
        className={`${inputClass} w-[170px]`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        aria-label="Move reason"
        placeholder={correction ? "Reason (required)" : "Reason (optional)"}
      />
      <label className="inline-flex items-center gap-1 text-[12px] text-slate2">
        <input
          type="checkbox"
          checked={correction}
          onChange={(e) => setCorrection(e.target.checked)}
        />
        Correction
      </label>
      <button
        type="button"
        className={subtleButtonClass}
        disabled={busy || !locationId}
        onClick={() =>
          void run(() =>
            moveInternalAction({
              packageId,
              toLocationId: locationId,
              reason: reason.trim() || null,
              correction,
            }),
          )
        }
      >
        Move
      </button>
      {error ? <span className="text-[12px] text-red">{error}</span> : null}
    </span>
  );
}

export function ReadyForDispatchForm({
  packageId,
  locations,
}: {
  packageId: string;
  locations: LocationOption[];
}) {
  const { error, busy, run } = useAction();
  const [locationId, setLocationId] = useState("");
  const dispatchLocations = locations.filter((l) => l.zoneKind === "DISPATCH");
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <select
        className={`${inputClass} w-[200px]`}
        value={locationId}
        onChange={(e) => setLocationId(e.target.value)}
        aria-label="Dispatch staging location (optional)"
      >
        <option value="">Dispatch staging (optional)…</option>
        {dispatchLocations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.fullCode}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={subtleButtonClass}
        disabled={busy}
        onClick={() =>
          void run(() => markReadyForDispatchAction(packageId, locationId || null))
        }
      >
        Ready for dispatch
      </button>
      {error ? <span className="text-[12px] text-red">{error}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Handovers
// ---------------------------------------------------------------------------

export interface HandoverPackageOption {
  packageId: string;
  trackingId: string;
}

export interface ReceiverOption {
  userId: string;
  label: string;
}

export function HandoverCreateForm({
  warehouseId,
  giverLabel,
  packages,
  receivers,
}: {
  warehouseId: string;
  giverLabel: string;
  packages: HandoverPackageOption[];
  receivers: ReceiverOption[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [receiver, setReceiver] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggle(packageId: string) {
    setSelected((prev) =>
      prev.includes(packageId)
        ? prev.filter((id) => id !== packageId)
        : [...prev, packageId],
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    const toWarehouse = receiver === "__warehouse__";
    const result = await initiateHandoverAction({
      packageIds: selected,
      toCustodianType: toWarehouse ? "WAREHOUSE" : "USER",
      toUserId: toWarehouse ? null : receiver,
      toWarehouseId: toWarehouse ? warehouseId : null,
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setMessage(
      `Handover batch created (${result.data.expectedCount} package(s), ${giverLabel} → ${result.data.toLabel}). Custody moves when the receiver confirms each package.`,
    );
    setSelected([]);
    setReceiver("");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-2">
      <div className="text-[13px] text-ink">
        From <strong>{giverLabel}</strong>
      </div>
      <div className="flex flex-wrap gap-2">
        {packages.map((pkg) => (
          <label
            key={pkg.packageId}
            className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 font-mono text-[12px] text-ink"
          >
            <input
              type="checkbox"
              checked={selected.includes(pkg.packageId)}
              onChange={() => toggle(pkg.packageId)}
            />
            {pkg.trackingId}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-[260px]">
          <Field label="Hand over to">
            <select
              className={inputClass}
              value={receiver}
              onChange={(e) => setReceiver(e.target.value)}
              required
            >
              <option value="">Select receiver…</option>
              <option value="__warehouse__">The warehouse itself</option>
              {receivers.map((r) => (
                <option key={r.userId} value={r.userId}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <button
          type="submit"
          className={primaryButtonClass}
          disabled={busy || selected.length === 0 || !receiver}
        >
          Start handover ({selected.length})
        </button>
      </div>
      {error ? <ErrorBox message={error} /> : null}
      {message ? <OkBox message={message} /> : null}
    </form>
  );
}

export function HandoverConfirmButton({
  batchId,
  packageId,
}: {
  batchId: string;
  packageId: string;
}) {
  const { error, busy, run } = useAction();
  const [damaged, setDamaged] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <label className="inline-flex items-center gap-1 text-[12px] text-slate2">
        <input
          type="checkbox"
          checked={damaged}
          onChange={(e) => setDamaged(e.target.checked)}
        />
        Damaged
      </label>
      <button
        type="button"
        className={subtleButtonClass}
        disabled={busy}
        onClick={() =>
          void run(() =>
            confirmHandoverAction({
              batchId,
              packageId,
              condition: damaged ? "DAMAGED" : "GOOD",
            }),
          )
        }
      >
        Confirm receipt
      </button>
      {error ? <span className="text-[12px] text-red">{error}</span> : null}
    </span>
  );
}

export function CloseHandoverButton({ batchId }: { batchId: string }) {
  const { error, busy, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={subtleButtonClass}
        disabled={busy}
        onClick={() => {
          if (
            window.confirm(
              "Close this handover short? Unconfirmed packages are marked MISSING and the batch becomes DISPUTED — this cannot be undone.",
            )
          ) {
            void run(() => closeHandoverBatchAction(batchId));
          }
        }}
      >
        Close short (dispute)
      </button>
      {error ? <span className="text-[12px] text-red">{error}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Supplies
// ---------------------------------------------------------------------------

export function StockItemCreateForm({ warehouseId }: { warehouseId: string }) {
  const router = useRouter();
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("PCS");
  const [reorderLevel, setReorderLevel] = useState("0");
  const [initialQuantity, setInitialQuantity] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await createStockItemAction({
      warehouseId,
      sku: sku.trim(),
      name: name.trim(),
      unit: unit as "PCS" | "ROLL" | "KG",
      reorderLevel: Number(reorderLevel) || 0,
      initialQuantity: Number(initialQuantity) || 0,
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setSku("");
    setName("");
    setInitialQuantity("0");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <div className="w-[130px]">
          <Field label="SKU">
            <input className={inputClass} value={sku} onChange={(e) => setSku(e.target.value)} required />
          </Field>
        </div>
        <div className="min-w-[180px] flex-1">
          <Field label="Name">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
        </div>
        <div className="w-[90px]">
          <Field label="Unit">
            <select className={inputClass} value={unit} onChange={(e) => setUnit(e.target.value)}>
              <option value="PCS">PCS</option>
              <option value="ROLL">ROLL</option>
              <option value="KG">KG</option>
            </select>
          </Field>
        </div>
        <div className="w-[110px]">
          <Field label="Reorder at">
            <input
              className={inputClass}
              type="number"
              min="0"
              value={reorderLevel}
              onChange={(e) => setReorderLevel(e.target.value)}
            />
          </Field>
        </div>
        <div className="w-[110px]">
          <Field label="Opening qty">
            <input
              className={inputClass}
              type="number"
              min="0"
              value={initialQuantity}
              onChange={(e) => setInitialQuantity(e.target.value)}
            />
          </Field>
        </div>
      </div>
      {error ? <ErrorBox message={error} /> : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          Add stock item
        </button>
      </div>
    </form>
  );
}

export function StockMovementForm({ stockItemId }: { stockItemId: string }) {
  const { error, busy, run } = useAction();
  const [type, setType] = useState("ISSUE");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <select
        className={`${inputClass} w-[150px]`}
        value={type}
        onChange={(e) => setType(e.target.value)}
      >
        <option value="ISSUE">Issue</option>
        <option value="PURCHASE">Receive (purchase)</option>
        <option value="RETURN">Return</option>
        <option value="ADJUSTMENT">Adjustment (±)</option>
        <option value="DAMAGE_WRITE_OFF">Damage write-off</option>
      </select>
      <input
        className={`${inputClass} w-[90px]`}
        type="number"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        placeholder="Qty"
      />
      <input
        className={`${inputClass} w-[150px]`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason"
      />
      <button
        type="button"
        className={subtleButtonClass}
        disabled={busy || !quantity}
        onClick={() =>
          void run(() =>
            recordStockMovementAction({
              stockItemId,
              type: type as "ISSUE" | "PURCHASE" | "RETURN" | "ADJUSTMENT" | "DAMAGE_WRITE_OFF",
              quantity: Number(quantity),
              reason: reason.trim() || null,
            }),
          ).then(() => {
            setQuantity("");
            setReason("");
          })
        }
      >
        Apply
      </button>
      {error ? <span className="text-[12px] text-red">{error}</span> : null}
    </span>
  );
}

export function StockItemActiveToggle({
  stockItemId,
  isActive,
}: {
  stockItemId: string;
  isActive: boolean;
}) {
  const { error, busy, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={subtleButtonClass}
        disabled={busy}
        onClick={() =>
          void run(() => updateStockItemAction({ stockItemId, isActive: !isActive }))
        }
      >
        {isActive ? "Deactivate" : "Reactivate"}
      </button>
      {error ? <span className="text-[12px] text-red">{error}</span> : null}
    </span>
  );
}
