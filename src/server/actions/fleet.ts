"use server";

import { revalidatePath } from "next/cache";

import {
  AuthorizationError,
  getActorContext,
  requireUnflagged,
  type ActorContext,
} from "@/lib/auth/permissions";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import type { ActionResult } from "@/server/actions/warehouses";
import {
  createDriverProfile,
  setDriverEmploymentStatus,
  updateDriverProfile,
  type CreateDriverInput,
  type DriverView,
  type SetEmploymentStatusInput,
  type UpdateDriverInput,
} from "@/server/services/drivers";
import {
  assignVehicleDriver,
  createVehicle,
  recordVehicleMaintenance,
  setVehicleStatus,
  updateVehicle,
  type CreateVehicleInput,
  type RecordMaintenanceInput,
  type UpdateVehicleInput,
  type VehicleMaintenanceView,
  type VehicleView,
} from "@/server/services/vehicles";

/**
 * Server Actions for Phase 5 fleet (drivers + vehicles) — same
 * contract as the other modules (session actor, P2-3 gate,
 * service-side permission + scope checks with audited denials).
 */

async function withActor<T>(
  fn: (actor: ActorContext) => Promise<T>,
): Promise<ActionResult<T>> {
  const actor = await getActorContext();
  if (!actor) return { success: false, error: "Authentication required" };
  try {
    requireUnflagged(actor); // P2-3 gate
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

function revalidateFleetSurfaces() {
  for (const base of ["/admin", "/super-admin", "/warehouse", "/staff"]) {
    revalidatePath(`${base}/vehicles`);
    revalidatePath(`${base}/drivers`);
  }
}

// --- Drivers -------------------------------------------------------------

export async function createDriverProfileAction(
  input: CreateDriverInput,
): Promise<ActionResult<DriverView>> {
  const result = await withActor((actor) => createDriverProfile(actor, input));
  if (result.success) revalidateFleetSurfaces();
  return result;
}

export async function updateDriverProfileAction(
  input: UpdateDriverInput,
): Promise<ActionResult<DriverView>> {
  const result = await withActor((actor) => updateDriverProfile(actor, input));
  if (result.success) revalidateFleetSurfaces();
  return result;
}

export async function setDriverEmploymentStatusAction(
  input: SetEmploymentStatusInput,
): Promise<ActionResult<DriverView>> {
  const result = await withActor((actor) => setDriverEmploymentStatus(actor, input));
  if (result.success) revalidateFleetSurfaces();
  return result;
}

// --- Vehicles --------------------------------------------------------------

export async function createVehicleAction(
  input: CreateVehicleInput,
): Promise<ActionResult<VehicleView>> {
  const result = await withActor((actor) => createVehicle(actor, input));
  if (result.success) revalidateFleetSurfaces();
  return result;
}

export async function updateVehicleAction(
  input: UpdateVehicleInput,
): Promise<ActionResult<VehicleView>> {
  const result = await withActor((actor) => updateVehicle(actor, input));
  if (result.success) revalidateFleetSurfaces();
  return result;
}

export async function assignVehicleDriverAction(
  vehicleId: string,
  driverId: string | null,
): Promise<ActionResult<VehicleView>> {
  const result = await withActor((actor) => assignVehicleDriver(actor, vehicleId, driverId));
  if (result.success) revalidateFleetSurfaces();
  return result;
}

export async function setVehicleStatusAction(
  vehicleId: string,
  status: "AVAILABLE" | "ASSIGNED" | "MAINTENANCE" | "OFFLINE",
): Promise<ActionResult<VehicleView>> {
  const result = await withActor((actor) => setVehicleStatus(actor, vehicleId, status));
  if (result.success) revalidateFleetSurfaces();
  return result;
}

export async function recordVehicleMaintenanceAction(
  input: RecordMaintenanceInput,
): Promise<ActionResult<VehicleMaintenanceView>> {
  const result = await withActor((actor) => recordVehicleMaintenance(actor, input));
  if (result.success) revalidateFleetSurfaces();
  return result;
}
