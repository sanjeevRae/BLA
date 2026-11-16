import Link from "next/link";

import type { ActorContext } from "@/lib/auth/actor";
import { hasPermission } from "@/lib/auth/actor";
import { formatPaisa } from "@/components/bookings/ui";
import { listWarehouses } from "@/server/services/warehouses";
import {
  getDriverProfile,
  listDriverCandidates,
  listDrivers,
  type DriverProfileView,
  type DriverView,
} from "@/server/services/drivers";
import {
  listVehicleMaintenance,
  listVehicles,
  type VehicleView,
} from "@/server/services/vehicles";
import { SectionCard } from "@/components/warehouses/ui";
import {
  CreateDriverProfileForm,
  CreateVehicleForm,
  DriverAdminButtons,
  RecordMaintenanceForm,
  UpdateDriverLicenceForm,
  UpdateVehicleDocsForm,
  VehicleAdminButtons,
  type FleetDriverOption,
  type FleetWarehouseOption,
} from "@/components/fleet/forms";

/**
 * Phase 5 fleet screens (admin + super-admin dashboards; warehouse
 * admins see the same pages scoped to their warehouses for drivers).
 * Real DB data only, via the fleet services.
 */

function PageHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
        {eyebrow}
      </div>
      <h1 className="mt-0.5 text-[22px] font-bold text-ink">{title}</h1>
    </div>
  );
}

async function warehouseOptions(actor: ActorContext): Promise<FleetWarehouseOption[]> {
  const { items } = await listWarehouses(actor, { pageSize: 100 });
  return items.map((w) => ({ id: w.id, code: w.code, name: w.name }));
}

function DriverRow({
  driver,
  canManage,
}: {
  driver: DriverView;
  canManage: boolean;
}) {
  return (
    <div className="rounded-md border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[15px] font-bold text-ink">{driver.fullName}</div>
          <div className="text-[12px] text-slate2">
            {driver.email} · roles {driver.roles.join(", ") || "—"} · home{" "}
            {driver.homeWarehouseCode}
          </div>
        </div>
        <div className="text-right text-[12px] text-slate2">
          <div>
            Employment <strong className="text-ink">{driver.employmentStatus}</strong> ·
            Availability <strong className="text-ink">{driver.availabilityStatus}</strong>
          </div>
          <div>{driver.currentTripId ? "On an active trip" : "Not on a trip"}</div>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
        <div>
          <dt className="text-slate2">Licence</dt>
          <dd className="font-medium text-ink">
            {driver.licenseNumber}
            {driver.licenseCategory ? ` (${driver.licenseCategory})` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-slate2">Licence expiry</dt>
          <dd className="font-medium text-ink">
            {driver.licenseExpiry}
            {driver.licenseExpired ? " — EXPIRED" : ""}
          </dd>
        </div>
        <div>
          <dt className="text-slate2">Capabilities</dt>
          <dd className="font-medium text-ink">{driver.capabilities.join(", ") || "—"}</dd>
        </div>
        <div>
          <dt className="text-slate2">Emergency contact</dt>
          <dd className="font-medium text-ink">
            {driver.emergencyContactName ?? "—"}
            {driver.emergencyContactPhone ? ` · ${driver.emergencyContactPhone}` : ""}
          </dd>
        </div>
      </dl>
      {canManage ? (
        <div className="mt-3 flex flex-col gap-3">
          <DriverAdminButtons
            driverId={driver.id}
            employmentStatus={driver.employmentStatus}
          />
          <UpdateDriverLicenceForm
            driverId={driver.id}
            licenseNumber={driver.licenseNumber}
            licenseExpiry={driver.licenseExpiry}
          />
        </div>
      ) : null}
    </div>
  );
}

export async function DriversPage({ actor }: { actor: ActorContext }) {
  const canManage = hasPermission(actor, "driver.manage");
  const { items } = await listDrivers(actor, { pageSize: 100 });
  const candidates = canManage ? await listDriverCandidates(actor) : [];
  const warehouses = canManage ? await warehouseOptions(actor) : [];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Fleet" title="Drivers" />
      {canManage ? (
        <SectionCard title="Create driver profile">
          <CreateDriverProfileForm candidates={candidates} warehouses={warehouses} />
        </SectionCard>
      ) : null}
      <SectionCard title={`Driver profiles (${items.length})`}>
        {items.length === 0 ? (
          <p className="text-[13px] text-slate2">No driver profiles yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {items.map((driver) => (
              <DriverRow key={driver.id} driver={driver} canManage={canManage} />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

async function VehicleRow({
  actor,
  vehicle,
  canManage,
  canAssign,
  driverOptions,
}: {
  actor: ActorContext;
  vehicle: VehicleView;
  canManage: boolean;
  canAssign: boolean;
  driverOptions: FleetDriverOption[];
}) {
  const maintenance = await listVehicleMaintenance(actor, vehicle.id).catch(() => []);
  return (
    <div className="rounded-md border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[15px] font-bold text-ink">{vehicle.registration}</div>
          <div className="text-[12px] text-slate2">
            {vehicle.type} · home {vehicle.homeWarehouseCode ?? "—"} · default driver{" "}
            {vehicle.assignedDriverName ?? "—"}
          </div>
        </div>
        <div className="text-right text-[12px] text-slate2">
          <div>
            Status <strong className="text-ink">{vehicle.status}</strong> · Inspection{" "}
            <strong className="text-ink">{vehicle.inspectionStatus}</strong>
          </div>
          <div>
            {vehicle.assignmentBlockers.length > 0
              ? `Not assignable: ${vehicle.assignmentBlockers.join("; ")}`
              : "Assignable to a trip"}
          </div>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
        <div>
          <dt className="text-slate2">Capacity</dt>
          <dd className="font-medium text-ink">
            {vehicle.capacityKg ? `${vehicle.capacityKg} kg` : "—"}
            {vehicle.capacityVolumeM3 ? ` · ${vehicle.capacityVolumeM3} m³` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-slate2">Insurance expiry</dt>
          <dd className="font-medium text-ink">{vehicle.insuranceExpiry ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-slate2">Registration expiry</dt>
          <dd className="font-medium text-ink">{vehicle.registrationExpiry ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-slate2">Maintenance records</dt>
          <dd className="font-medium text-ink">{maintenance.length}</dd>
        </div>
      </dl>
      {maintenance.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1 text-[12px] text-slate2">
          {maintenance.slice(0, 5).map((m) => (
            <li key={m.id}>
              {m.kind} · scheduled {new Date(m.scheduledAt).toLocaleDateString("en-GB")}
              {m.completedAt
                ? ` · completed ${new Date(m.completedAt).toLocaleDateString("en-GB")}`
                : " · open"}
              {m.costPaisa ? ` · ${formatPaisa(m.costPaisa)}` : ""}
              {m.notes ? ` · ${m.notes}` : ""} (by {m.recordedByName})
            </li>
          ))}
        </ul>
      ) : null}
      {canManage || canAssign ? (
        <div className="mt-3 flex flex-col gap-3">
          <VehicleAdminButtons
            vehicleId={vehicle.id}
            status={vehicle.status}
            drivers={driverOptions}
            assignedDriverId={vehicle.assignedDriverId}
            canManage={canManage}
            canAssign={canAssign}
          />
          {canManage ? (
            <>
              <UpdateVehicleDocsForm
                vehicleId={vehicle.id}
                insuranceExpiry={vehicle.insuranceExpiry}
                registrationExpiry={vehicle.registrationExpiry}
              />
              <RecordMaintenanceForm vehicleId={vehicle.id} />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ProfileField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-slate2">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}

/**
 * Driver detail page (Phase 7) — shared by the admin, super-admin
 * and warehouse dashboards the way the fleet list pages are; the
 * service (getDriverProfile) enforces the fleet read gate + scope,
 * and the GPS section renders only when the profile carries the
 * `gps` key (operations.live_view holders only).
 */
export async function DriverDetailPage({
  actor,
  basePath,
  driverId,
}: {
  actor: ActorContext;
  basePath: string;
  driverId: string;
}) {
  const profile: DriverProfileView = await getDriverProfile(actor, driverId);
  const canManage = hasPermission(actor, "driver.manage");
  const hasGps = "gps" in profile;
  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link
          href={`${basePath}/drivers`}
          className="text-[12px] font-semibold text-brand"
        >
          ← All drivers
        </Link>
        <h1 className="mt-1 text-[22px] font-bold text-ink">{profile.fullName}</h1>
        <p className="text-[13px] text-slate2">
          {profile.email}
          {profile.phone ? ` · ${profile.phone}` : ""} · home{" "}
          {profile.homeWarehouse.code} — {profile.homeWarehouse.name}
        </p>
      </div>

      <SectionCard title="Driver profile">
        <dl className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
          <ProfileField
            label="Type"
            value={profile.roles.join(", ") || "—"}
          />
          <ProfileField
            label="Capabilities"
            value={profile.capabilities.join(", ") || "—"}
          />
          <ProfileField label="Employment" value={profile.employmentStatus} />
          <ProfileField label="Availability" value={profile.availabilityStatus} />
          <ProfileField
            label="Licence"
            value={`${profile.licenseNumber}${profile.licenseCategory ? ` (${profile.licenseCategory})` : ""}`}
          />
          <ProfileField
            label="Licence expiry"
            value={`${profile.licenseExpiry}${profile.licenseExpired ? " — EXPIRED" : ""}`}
          />
          <ProfileField
            label="Emergency contact"
            value={`${profile.emergencyContactName ?? "—"}${profile.emergencyContactPhone ? ` · ${profile.emergencyContactPhone}` : ""}`}
          />
          <ProfileField label="Account status" value={profile.userStatus} />
        </dl>
        {canManage ? (
          <div className="mt-4 flex flex-col gap-3">
            <DriverAdminButtons
              driverId={profile.id}
              employmentStatus={profile.employmentStatus}
            />
            <UpdateDriverLicenceForm
              driverId={profile.id}
              licenseNumber={profile.licenseNumber}
              licenseExpiry={profile.licenseExpiry}
            />
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="Current vehicle">
        {profile.currentVehicle ? (
          <p className="text-[13px] text-ink">
            <span className="font-mono font-bold">{profile.currentVehicle.registration}</span>{" "}
            · {profile.currentVehicle.type} · {profile.currentVehicle.status}
          </p>
        ) : (
          <p className="text-[13px] text-slate2">No vehicle currently assigned.</p>
        )}
      </SectionCard>

      <SectionCard title="Current work">
        {profile.currentTrip || profile.currentBatch ? (
          <div className="flex flex-col gap-3 text-[13px] text-ink">
            {profile.currentTrip ? (
              <div>
                <div className="font-semibold">
                  Trip {profile.currentTrip.tripNumber} · {profile.currentTrip.status}
                </div>
                <div className="text-slate2">
                  {profile.currentTrip.origin.name} → {profile.currentTrip.destination.name}
                  {profile.currentTrip.vehicleRegistration
                    ? ` · ${profile.currentTrip.vehicleRegistration}`
                    : ""}
                </div>
              </div>
            ) : null}
            {profile.currentBatch ? (
              <div>
                <div className="font-semibold">
                  {profile.currentBatch.kind} batch · {profile.currentBatch.status} ·{" "}
                  {profile.currentBatch.batchDate}
                </div>
                <div className="text-slate2">
                  {profile.currentBatch.warehouse.code} — {profile.currentBatch.warehouse.name}{" "}
                  · <span className="tnum">{profile.currentBatch.assignedCount}</span> assigned
                  · <span className="tnum">{profile.currentBatch.deliveredCount}</span>{" "}
                  delivered · <span className="tnum">{profile.currentBatch.remainingCount}</span>{" "}
                  remaining
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-[13px] text-slate2">No active trip or delivery batch.</p>
        )}
      </SectionCard>

      {hasGps ? (
        <SectionCard title="Live location (GPS)">
          {profile.gps ? (
            <dl className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
              <ProfileField
                label="Position"
                value={`${profile.gps.latitude.toFixed(5)}, ${profile.gps.longitude.toFixed(5)}`}
              />
              <ProfileField
                label="Accuracy"
                value={`±${Math.round(profile.gps.accuracyMeters)} m`}
              />
              <ProfileField label="Freshness" value={profile.gps.freshnessState} />
              <ProfileField
                label="Last update"
                value={new Date(profile.gps.lastReceivedAt).toLocaleString("en-GB")}
              />
              <ProfileField label="Session type" value={profile.gps.trackingType} />
            </dl>
          ) : (
            <p className="text-[13px] text-slate2">
              No current location snapshot for this driver.
            </p>
          )}
        </SectionCard>
      ) : null}

      <SectionCard title={`Recent trips (${profile.recentTrips.length})`}>
        {profile.recentTrips.length === 0 ? (
          <p className="text-[13px] text-slate2">No trips yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-[13px] text-ink">
            {profile.recentTrips.map((trip) => (
              <li
                key={trip.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2"
              >
                <span className="font-semibold">{trip.tripNumber}</span>
                <span className="text-slate2">
                  {trip.origin.code} → {trip.destination.code} · {trip.status} ·{" "}
                  {new Date(trip.createdAt).toLocaleDateString("en-GB")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title={`Recent delivery batches (${profile.recentBatches.length})`}>
        {profile.recentBatches.length === 0 ? (
          <p className="text-[13px] text-slate2">No delivery batches yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-[13px] text-ink">
            {profile.recentBatches.map((batch) => (
              <li
                key={batch.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2"
              >
                <span className="font-semibold">
                  {batch.warehouse.code} · {batch.batchDate}
                </span>
                <span className="text-slate2">
                  {batch.kind} · {batch.status} ·{" "}
                  <span className="tnum">{batch.assignedCount}</span> assigned ·{" "}
                  <span className="tnum">{batch.deliveredCount}</span> delivered ·{" "}
                  <span className="tnum">{batch.remainingCount}</span> remaining
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

export async function VehiclesPage({ actor }: { actor: ActorContext }) {
  const canManage = hasPermission(actor, "vehicle.manage");
  const canAssign = canManage || hasPermission(actor, "vehicle.assign");
  const { items } = await listVehicles(actor, { pageSize: 100 });
  const { items: drivers } = await listDrivers(actor, { pageSize: 100 });
  const driverOptions: FleetDriverOption[] = drivers.map((d) => ({
    driverId: d.id,
    name: d.fullName,
  }));
  const warehouses = canManage ? await warehouseOptions(actor) : [];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Fleet" title="Vehicles" />
      {canManage ? (
        <SectionCard title="Add vehicle">
          <CreateVehicleForm warehouses={warehouses} drivers={driverOptions} />
        </SectionCard>
      ) : null}
      <SectionCard title={`Vehicles (${items.length})`}>
        {items.length === 0 ? (
          <p className="text-[13px] text-slate2">No vehicles yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {items.map((vehicle) => (
              <VehicleRow
                key={vehicle.id}
                actor={actor}
                vehicle={vehicle}
                canManage={canManage}
                canAssign={canAssign}
                driverOptions={driverOptions}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
