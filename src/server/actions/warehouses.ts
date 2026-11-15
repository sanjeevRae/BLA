"use server";

import { revalidatePath } from "next/cache";

import { AuthorizationError, getActorContext, type ActorContext } from "@/lib/auth/permissions";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import {
  assignMember,
  createStorageLocation,
  createWarehouse,
  createZone,
  removeMember,
  setWarehouseStatus,
  updateStorageLocation,
  updateWarehouse,
  updateZone,
  type AssignMemberInput,
  type CreateLocationInput,
  type CreateWarehouseInput,
  type CreateZoneInput,
  type UpdateLocationInput,
  type UpdateWarehouseInput,
  type UpdateZoneInput,
} from "@/server/services/warehouses";

/**
 * Server Actions for the warehouse module. Each action resolves the
 * actor from the session + database, delegates to WarehouseService
 * (which performs the permission and scope checks), and translates
 * domain errors into a form-friendly result. No action trusts any
 * role/permission/warehouse field sent by the client.
 */

export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

async function withActor<T>(fn: (actor: ActorContext) => Promise<T>): Promise<ActionResult<T>> {
  const actor = await getActorContext();
  if (!actor) return { success: false, error: "Authentication required" };
  try {
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

function revalidateWarehousePaths(warehouseId?: string): void {
  revalidatePath("/admin/warehouses");
  revalidatePath("/super-admin/warehouses");
  revalidatePath("/warehouse");
  if (warehouseId) {
    revalidatePath(`/admin/warehouses/${warehouseId}`);
    revalidatePath(`/super-admin/warehouses/${warehouseId}`);
  }
}

export async function createWarehouseAction(input: CreateWarehouseInput) {
  const result = await withActor((actor) => createWarehouse(actor, input));
  if (result.success) revalidateWarehousePaths(result.data.id);
  return result;
}

export async function updateWarehouseAction(warehouseId: string, input: UpdateWarehouseInput) {
  const result = await withActor((actor) => updateWarehouse(actor, warehouseId, input));
  if (result.success) revalidateWarehousePaths(warehouseId);
  return result;
}

export async function activateWarehouseAction(warehouseId: string) {
  const result = await withActor((actor) => setWarehouseStatus(actor, warehouseId, "ACTIVE"));
  if (result.success) revalidateWarehousePaths(warehouseId);
  return result;
}

export async function deactivateWarehouseAction(warehouseId: string) {
  const result = await withActor((actor) => setWarehouseStatus(actor, warehouseId, "INACTIVE"));
  if (result.success) revalidateWarehousePaths(warehouseId);
  return result;
}

export async function assignMemberAction(warehouseId: string, input: AssignMemberInput) {
  const result = await withActor((actor) => assignMember(actor, warehouseId, input));
  if (result.success) revalidateWarehousePaths(warehouseId);
  return result;
}

export async function removeMemberAction(warehouseId: string, membershipId: string) {
  const result = await withActor((actor) => removeMember(actor, warehouseId, membershipId));
  if (result.success) revalidateWarehousePaths(warehouseId);
  return result;
}

export async function createZoneAction(warehouseId: string, input: CreateZoneInput) {
  const result = await withActor((actor) => createZone(actor, warehouseId, input));
  if (result.success) revalidateWarehousePaths(warehouseId);
  return result;
}

export async function updateZoneAction(zoneId: string, input: UpdateZoneInput) {
  const result = await withActor((actor) => updateZone(actor, zoneId, input));
  if (result.success) revalidateWarehousePaths();
  return result;
}

export async function createLocationAction(zoneId: string, input: CreateLocationInput) {
  const result = await withActor((actor) => createStorageLocation(actor, zoneId, input));
  if (result.success) revalidateWarehousePaths();
  return result;
}

export async function updateLocationAction(locationId: string, input: UpdateLocationInput) {
  const result = await withActor((actor) => updateStorageLocation(actor, locationId, input));
  if (result.success) revalidateWarehousePaths();
  return result;
}
