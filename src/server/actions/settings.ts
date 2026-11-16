"use server";

import { revalidatePath } from "next/cache";

import {
  AuthorizationError,
  getActorContext,
  requireAccessGranted,
} from "@/lib/auth/permissions";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import { updateSetting, type SettingView } from "@/server/services/system-settings";
import type { ActionResult } from "@/server/actions/warehouses";

/** Update one system setting (settings.manage). The service validates
 *  strictly — idle-timeout and MFA values are live security gates. */
export async function updateSettingAction(
  key: string,
  value: unknown,
): Promise<ActionResult<SettingView>> {
  const actor = await getActorContext();
  if (!actor) return { success: false, error: "Authentication required" };
  try {
    requireAccessGranted(actor); // P2-3
    const data = await updateSetting(actor, key, value);
    revalidatePath("/super-admin/settings");
    return { success: true, data };
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
