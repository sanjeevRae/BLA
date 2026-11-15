import "server-only";

import { prisma } from "@/lib/db/prisma";

/**
 * SystemSetting access (docs/database-schema.md §11, security doc §2).
 *
 * Settings are data, never code: the values below are seeded
 * create-only by prisma/seed.ts and may be tightened by an operator
 * without a deploy. Every reader falls back to the DOCUMENTED default
 * when the row is absent or malformed, so a database without the seed
 * (e.g. a fresh test database) behaves exactly as the security doc
 * specifies. There is no settings UI yet — rows are edited directly
 * in the database by a super admin; the fallback defaults are the
 * Phase 10 production-gate values from docs/security-architecture.md.
 */

export const SETTING_IDLE_TIMEOUT_STAFF_HOURS = "session.idle_timeout.staff_hours";
export const SETTING_IDLE_TIMEOUT_PRIVILEGED_HOURS = "session.idle_timeout.privileged_hours";
export const SETTING_MFA_REQUIRED_FOR_PRIVILEGED = "auth.mfa_required_for_privileged";

/** Security doc §2: idle timeout 24h for staff consoles. */
export const DEFAULT_IDLE_TIMEOUT_STAFF_HOURS = 24;
/** Security doc §2: idle timeout 12h for privileged roles
 *  (Super Admin, Admin, Finance). */
export const DEFAULT_IDLE_TIMEOUT_PRIVILEGED_HOURS = 12;
/** Security doc §2: MFA required for super_admin and admin. */
export const DEFAULT_MFA_REQUIRED_FOR_PRIVILEGED = true;

/** Roles whose sessions idle out on the shorter privileged limit
 *  (security doc §2 expiry bullet: Super Admin, Admin, Finance). */
export const IDLE_PRIVILEGED_ROLES: ReadonlySet<string> = new Set([
  "SUPER_ADMIN",
  "ADMIN",
  "FINANCE",
]);

/** Roles the MFA policy applies to (security doc §2 MFA bullet:
 *  required for super_admin and admin; enrolment is part of first
 *  login for those roles). */
export const MFA_PRIVILEGED_ROLES: ReadonlySet<string> = new Set(["SUPER_ADMIN", "ADMIN"]);

async function readSettingValue(key: string): Promise<unknown> {
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}

function asPositiveHours(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return fallback;
}

/** Idle timeout in milliseconds for the given role set. */
export async function getIdleTimeoutMs(roles: readonly string[]): Promise<number> {
  const privileged = roles.some((role) => IDLE_PRIVILEGED_ROLES.has(role));
  const [staffRaw, privilegedRaw] = await Promise.all([
    readSettingValue(SETTING_IDLE_TIMEOUT_STAFF_HOURS),
    readSettingValue(SETTING_IDLE_TIMEOUT_PRIVILEGED_HOURS),
  ]);
  const hours = privileged
    ? asPositiveHours(privilegedRaw, DEFAULT_IDLE_TIMEOUT_PRIVILEGED_HOURS)
    : asPositiveHours(staffRaw, DEFAULT_IDLE_TIMEOUT_STAFF_HOURS);
  return hours * 60 * 60 * 1000;
}

/** Whether the MFA policy currently requires privileged users to enrol. */
export async function isMfaRequiredForPrivileged(): Promise<boolean> {
  const value = await readSettingValue(SETTING_MFA_REQUIRED_FOR_PRIVILEGED);
  return typeof value === "boolean" ? value : DEFAULT_MFA_REQUIRED_FOR_PRIVILEGED;
}

/** Whether any of the roles is in the MFA policy's privileged set. */
export function isMfaPrivilegedRoleSet(roles: readonly string[]): boolean {
  return roles.some((role) => MFA_PRIVILEGED_ROLES.has(role));
}
