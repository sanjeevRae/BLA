"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import {
  assignVehicleDriverAction,
  createDriverProfileAction,
  createVehicleAction,
  recordVehicleMaintenanceAction,
  setDriverEmploymentStatusAction,
  setVehicleStatusAction,
  updateDriverProfileAction,
  updateVehicleAction,
} from "@/server/actions/fleet";
import { statusLabel } from "@/lib/status/labels";
import { DRIVER_CAPABILITIES, VEHICLE_MAINTENANCE_KINDS, VEHICLE_TYPES } from "@/lib/transfers/domain";
import {
  ErrorBox,
  inputClass,
  labelClass,
  primaryButtonClass,
  subtleButtonClass,
} from "@/components/warehouses/ui";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      {children}
    </label>
  );
}

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
      return false;
    }
    router.refresh();
    return true;
  }
  return { error, busy, run };
}

export interface FleetWarehouseOption {
  id: string;
  code: string;
  name: string;
}
export interface DriverCandidateOption {
  userId: string;
  fullName: string;
  email: string;
  roles: string[];
}
export interface FleetDriverOption {
  driverId: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

export function CreateDriverProfileForm({
  candidates,
  warehouses,
}: {
  candidates: DriverCandidateOption[];
  warehouses: FleetWarehouseOption[];
}) {
  const router = useRouter();
  const [userId, setUserId] = useState("");
  const [homeWarehouseId, setHomeWarehouseId] = useState("");
  const [licenseNumber, setLicenseNumber] = useState("");
  const [licenseCategory, setLicenseCategory] = useState("");
  const [licenseExpiry, setLicenseExpiry] = useState("");
  const [emergencyContactName, setEmergencyContactName] = useState("");
  const [emergencyContactPhone, setEmergencyContactPhone] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>(["LINEHAUL"]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggleCapability(cap: string) {
    setCapabilities((prev) =>
      prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap],
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await createDriverProfileAction({
      userId,
      homeWarehouseId,
      licenseNumber: licenseNumber.trim(),
      licenseCategory: licenseCategory.trim() || null,
      licenseExpiry,
      emergencyContactName: emergencyContactName.trim() || null,
      emergencyContactPhone: emergencyContactPhone.trim() || null,
      capabilities: capabilities as (typeof DRIVER_CAPABILITIES)[number][],
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  if (candidates.length === 0) {
    return (
      <p className="text-[13px] text-slate2">
        No eligible users: a driver profile needs an active user holding the line-haul
        driver or rider role with no existing profile.
      </p>
    );
  }
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="User">
          <select
            className={inputClass}
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            required
          >
            <option value="">Select user…</option>
            {candidates.map((c) => (
              <option key={c.userId} value={c.userId}>
                {c.fullName} ({c.email}) — {c.roles.join(", ")}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Home warehouse">
          <select
            className={inputClass}
            value={homeWarehouseId}
            onChange={(e) => setHomeWarehouseId(e.target.value)}
            required
          >
            <option value="">Select warehouse…</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.code})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Licence number">
          <input
            className={inputClass}
            value={licenseNumber}
            onChange={(e) => setLicenseNumber(e.target.value)}
            required
          />
        </Field>
        <Field label="Licence category">
          <input
            className={inputClass}
            value={licenseCategory}
            onChange={(e) => setLicenseCategory(e.target.value)}
            placeholder="e.g. B, C"
          />
        </Field>
        <Field label="Licence expiry">
          <input
            className={inputClass}
            type="date"
            value={licenseExpiry}
            onChange={(e) => setLicenseExpiry(e.target.value)}
            required
          />
        </Field>
        <Field label="Capabilities">
          <span className="flex gap-3 pt-2">
            {DRIVER_CAPABILITIES.map((cap) => (
              <label key={cap} className="flex items-center gap-1 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={capabilities.includes(cap)}
                  onChange={() => toggleCapability(cap)}
                />
                {cap}
              </label>
            ))}
          </span>
        </Field>
        <Field label="Emergency contact name">
          <input
            className={inputClass}
            value={emergencyContactName}
            onChange={(e) => setEmergencyContactName(e.target.value)}
          />
        </Field>
        <Field label="Emergency contact phone">
          <input
            className={inputClass}
            value={emergencyContactPhone}
            onChange={(e) => setEmergencyContactPhone(e.target.value)}
          />
        </Field>
      </div>
      {error ? <ErrorBox message={error} /> : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Creating…" : "Create driver profile"}
        </button>
      </div>
    </form>
  );
}

export function DriverAdminButtons({
  driverId,
  employmentStatus,
}: {
  driverId: string;
  employmentStatus: string;
}) {
  const { error, busy, run } = useAction();
  const targets = ["ACTIVE", "ON_LEAVE", "SUSPENDED", "INACTIVE"].filter(
    (s) => s !== employmentStatus,
  );
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span className="flex flex-wrap gap-1">
        {targets.map((status) => (
          <button
            key={status}
            type="button"
            className={subtleButtonClass}
            disabled={busy}
            onClick={() =>
              run(() =>
                setDriverEmploymentStatusAction({
                  driverId,
                  employmentStatus: status as "ACTIVE" | "ON_LEAVE" | "SUSPENDED" | "INACTIVE",
                }),
              )
            }
          >
            Set {statusLabel("generic", status)}
          </button>
        ))}
      </span>
      {error ? <span className="text-[12px] text-danger">{error}</span> : null}
    </span>
  );
}

export function UpdateDriverLicenceForm({
  driverId,
  licenseNumber,
  licenseExpiry,
}: {
  driverId: string;
  licenseNumber: string;
  licenseExpiry: string;
}) {
  const { error, busy, run } = useAction();
  const [number, setNumber] = useState(licenseNumber);
  const [expiry, setExpiry] = useState(licenseExpiry);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() =>
          updateDriverProfileAction({
            driverId,
            licenseNumber: number.trim(),
            licenseExpiry: expiry,
          }),
        );
      }}
    >
      <Field label="Licence number">
        <input className={inputClass} value={number} onChange={(e) => setNumber(e.target.value)} />
      </Field>
      <Field label="Licence expiry">
        <input
          className={inputClass}
          type="date"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
        />
      </Field>
      <button type="submit" className={subtleButtonClass} disabled={busy}>
        Update licence
      </button>
      {error ? <ErrorBox message={error} /> : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

export function CreateVehicleForm({
  warehouses,
  drivers,
}: {
  warehouses: FleetWarehouseOption[];
  drivers: FleetDriverOption[];
}) {
  const router = useRouter();
  const [registration, setRegistration] = useState("");
  const [type, setType] = useState<(typeof VEHICLE_TYPES)[number]>("TRUCK");
  const [capacityKg, setCapacityKg] = useState("");
  const [capacityVolumeM3, setCapacityVolumeM3] = useState("");
  const [homeWarehouseId, setHomeWarehouseId] = useState("");
  const [insuranceExpiry, setInsuranceExpiry] = useState("");
  const [registrationExpiry, setRegistrationExpiry] = useState("");
  const [assignedDriverId, setAssignedDriverId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await createVehicleAction({
      registration: registration.trim(),
      type,
      capacityKg: capacityKg ? Number(capacityKg) : null,
      capacityVolumeM3: capacityVolumeM3 ? Number(capacityVolumeM3) : null,
      homeWarehouseId: homeWarehouseId || null,
      insuranceExpiry,
      registrationExpiry,
      assignedDriverId: assignedDriverId || null,
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
        <Field label="Registration">
          <input
            className={inputClass}
            value={registration}
            onChange={(e) => setRegistration(e.target.value)}
            placeholder="e.g. BA 2 KHA 4521"
            required
          />
        </Field>
        <Field label="Type">
          <select
            className={inputClass}
            value={type}
            onChange={(e) => setType(e.target.value as (typeof VEHICLE_TYPES)[number])}
          >
            {VEHICLE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Home warehouse (optional)">
          <select
            className={inputClass}
            value={homeWarehouseId}
            onChange={(e) => setHomeWarehouseId(e.target.value)}
          >
            <option value="">None</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.code})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Capacity (kg)">
          <input
            className={inputClass}
            type="number"
            min="0"
            step="0.001"
            value={capacityKg}
            onChange={(e) => setCapacityKg(e.target.value)}
          />
        </Field>
        <Field label="Capacity (m³)">
          <input
            className={inputClass}
            type="number"
            min="0"
            step="0.001"
            value={capacityVolumeM3}
            onChange={(e) => setCapacityVolumeM3(e.target.value)}
          />
        </Field>
        <Field label="Default driver (optional)">
          <select
            className={inputClass}
            value={assignedDriverId}
            onChange={(e) => setAssignedDriverId(e.target.value)}
          >
            <option value="">None</option>
            {drivers.map((d) => (
              <option key={d.driverId} value={d.driverId}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Insurance expiry">
          <input
            className={inputClass}
            type="date"
            value={insuranceExpiry}
            onChange={(e) => setInsuranceExpiry(e.target.value)}
            required
          />
        </Field>
        <Field label="Registration expiry">
          <input
            className={inputClass}
            type="date"
            value={registrationExpiry}
            onChange={(e) => setRegistrationExpiry(e.target.value)}
            required
          />
        </Field>
      </div>
      {error ? <ErrorBox message={error} /> : null}
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Creating…" : "Add vehicle"}
        </button>
      </div>
    </form>
  );
}

export function VehicleAdminButtons({
  vehicleId,
  status,
  drivers,
  assignedDriverId,
  canManage = true,
  canAssign = true,
}: {
  vehicleId: string;
  status: string;
  drivers: FleetDriverOption[];
  assignedDriverId: string | null;
  /** Status changes are vehicle.manage work (service-enforced). */
  canManage?: boolean;
  /** Default-driver assignment is vehicle.assign work (service-enforced);
   *  a Warehouse Admin holds it without vehicle.manage (Phase 6, M-4). */
  canAssign?: boolean;
}) {
  const { error, busy, run } = useAction();
  const [driverId, setDriverId] = useState(assignedDriverId ?? "");
  const manualTargets = ["AVAILABLE", "ASSIGNED", "MAINTENANCE", "OFFLINE"].filter(
    (s) => s !== status,
  );
  return (
    <span className="inline-flex flex-col items-start gap-2">
      <span className="flex flex-wrap items-center gap-1">
        {canManage && status !== "ON_TRIP"
          ? manualTargets.map((s) => (
              <button
                key={s}
                type="button"
                className={subtleButtonClass}
                disabled={busy}
                onClick={() =>
                  run(() =>
                    setVehicleStatusAction(
                      vehicleId,
                      s as "AVAILABLE" | "ASSIGNED" | "MAINTENANCE" | "OFFLINE",
                    ),
                  )
                }
              >
                Set {statusLabel("generic", s)}
              </button>
            ))
          : null}
        {canAssign ? (
          <>
            <select
              className={inputClass}
              value={driverId}
              onChange={(e) => setDriverId(e.target.value)}
            >
              <option value="">No default driver</option>
              {drivers.map((d) => (
                <option key={d.driverId} value={d.driverId}>
                  {d.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={subtleButtonClass}
              disabled={busy}
              onClick={() => run(() => assignVehicleDriverAction(vehicleId, driverId || null))}
            >
              Set default driver
            </button>
          </>
        ) : null}
      </span>
      {error ? <span className="text-[12px] text-danger">{error}</span> : null}
    </span>
  );
}

export function RecordMaintenanceForm({ vehicleId }: { vehicleId: string }) {
  const { error, busy, run } = useAction();
  const [kind, setKind] = useState<(typeof VEHICLE_MAINTENANCE_KINDS)[number]>("SCHEDULED");
  const [scheduledAt, setScheduledAt] = useState("");
  const [completedAt, setCompletedAt] = useState("");
  const [costRupees, setCostRupees] = useState("");
  const [notes, setNotes] = useState("");

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const result = await recordVehicleMaintenanceAction({
            vehicleId,
            kind,
            scheduledAt: new Date(scheduledAt).toISOString(),
            completedAt: completedAt ? new Date(completedAt).toISOString() : null,
            costPaisa: costRupees
              ? String(Math.round(Number(costRupees) * 100))
              : null,
            notes: notes.trim() || null,
          });
          if (result.success) {
            setScheduledAt("");
            setCompletedAt("");
            setCostRupees("");
            setNotes("");
          }
          return result;
        });
      }}
    >
      <Field label="Kind">
        <select
          className={inputClass}
          value={kind}
          onChange={(e) => setKind(e.target.value as (typeof VEHICLE_MAINTENANCE_KINDS)[number])}
        >
          {VEHICLE_MAINTENANCE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Scheduled at">
        <input
          className={inputClass}
          type="datetime-local"
          value={scheduledAt}
          onChange={(e) => setScheduledAt(e.target.value)}
          required
        />
      </Field>
      <Field label="Completed at (optional)">
        <input
          className={inputClass}
          type="datetime-local"
          value={completedAt}
          onChange={(e) => setCompletedAt(e.target.value)}
        />
      </Field>
      <Field label="Cost (NPR, optional)">
        <input
          className={inputClass}
          type="number"
          min="0"
          step="0.01"
          value={costRupees}
          onChange={(e) => setCostRupees(e.target.value)}
        />
      </Field>
      <Field label="Notes (optional)">
        <input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <button type="submit" className={subtleButtonClass} disabled={busy}>
        Record maintenance
      </button>
      {error ? <ErrorBox message={error} /> : null}
    </form>
  );
}

export function UpdateVehicleDocsForm({
  vehicleId,
  insuranceExpiry,
  registrationExpiry,
}: {
  vehicleId: string;
  insuranceExpiry: string | null;
  registrationExpiry: string | null;
}) {
  const { error, busy, run } = useAction();
  const [insurance, setInsurance] = useState(insuranceExpiry ?? "");
  const [registration, setRegistration] = useState(registrationExpiry ?? "");
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() =>
          updateVehicleAction({
            vehicleId,
            insuranceExpiry: insurance,
            registrationExpiry: registration,
          }),
        );
      }}
    >
      <Field label="Insurance expiry">
        <input
          className={inputClass}
          type="date"
          value={insurance}
          onChange={(e) => setInsurance(e.target.value)}
          required
        />
      </Field>
      <Field label="Registration expiry">
        <input
          className={inputClass}
          type="date"
          value={registration}
          onChange={(e) => setRegistration(e.target.value)}
          required
        />
      </Field>
      <button type="submit" className={subtleButtonClass} disabled={busy}>
        Update documents
      </button>
      {error ? <ErrorBox message={error} /> : null}
    </form>
  );
}
