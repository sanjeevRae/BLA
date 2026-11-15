import type { ActorContext } from "@/lib/auth/actor";
import { hasPermission } from "@/lib/auth/actor";
import { formatPaisa } from "@/components/bookings/ui";
import { listWarehouses } from "@/server/services/warehouses";
import {
  listDriverCandidates,
  listDrivers,
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
  driverOptions,
}: {
  actor: ActorContext;
  vehicle: VehicleView;
  canManage: boolean;
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
      {canManage ? (
        <div className="mt-3 flex flex-col gap-3">
          <VehicleAdminButtons
            vehicleId={vehicle.id}
            status={vehicle.status}
            drivers={driverOptions}
            assignedDriverId={vehicle.assignedDriverId}
          />
          <UpdateVehicleDocsForm
            vehicleId={vehicle.id}
            insuranceExpiry={vehicle.insuranceExpiry}
            registrationExpiry={vehicle.registrationExpiry}
          />
          <RecordMaintenanceForm vehicleId={vehicle.id} />
        </div>
      ) : null}
    </div>
  );
}

export async function VehiclesPage({ actor }: { actor: ActorContext }) {
  const canManage = hasPermission(actor, "vehicle.manage");
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
                driverOptions={driverOptions}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
