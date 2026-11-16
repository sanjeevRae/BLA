import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import type { ActorContext } from "@/lib/auth/actor";
import { DomainValidationError } from "@/lib/errors";
import {
  TRACKING_CONFIG_DEFAULTS,
  TRACKING_CONFIG_FIELD_RULES,
  TRACKING_CONFIG_SETTING_KEY,
  resolveTrackingConfig,
  validateTrackingConfigPatch,
  type TrackingConfig,
} from "@/lib/tracking/config";
import { requirePermAudited } from "@/server/services/scoping";

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

/** Sanity bounds for operator-set idle timeouts (Phase 10 review
 *  P10-R5): a stored value outside 1–168 hours (one week) is
 *  treated as malformed and falls back to the documented default,
 *  so a typo'd row (e.g. 100000) can never silently disable the
 *  idle gate. */
export const MIN_IDLE_TIMEOUT_HOURS = 1;
export const MAX_IDLE_TIMEOUT_HOURS = 168;

function asSaneIdleHours(value: unknown, fallback: number): number {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_IDLE_TIMEOUT_HOURS &&
    value <= MAX_IDLE_TIMEOUT_HOURS
  ) {
    return value;
  }
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
    ? asSaneIdleHours(privilegedRaw, DEFAULT_IDLE_TIMEOUT_PRIVILEGED_HOURS)
    : asSaneIdleHours(staffRaw, DEFAULT_IDLE_TIMEOUT_STAFF_HOURS);
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

// ---------------------------------------------------------------------------
// Phase 6 (V2): settings read/write surface (audit H-4) — settings.manage
// ---------------------------------------------------------------------------

export const SETTING_TRACKING_CONFIG = TRACKING_CONFIG_SETTING_KEY;

export interface SettingView {
  key: string;
  /** Current effective value (stored value when valid, else the default). */
  value: unknown;
  defaultValue: unknown;
  description: string;
  kind: "hours" | "boolean" | "tracking-config";
  bounds?: { min: number; max: number };
  /** tracking.config only: per-field effective values, defaults, bounds. */
  trackingFields?: {
    field: keyof TrackingConfig;
    value: number;
    defaultValue: number;
    min: number;
    max: number;
    integer: boolean;
  }[];
}

const SETTING_DESCRIPTIONS: Record<string, string> = {
  [SETTING_IDLE_TIMEOUT_STAFF_HOURS]:
    "Session idle timeout (hours) for staff consoles — security doc §2.",
  [SETTING_IDLE_TIMEOUT_PRIVILEGED_HOURS]:
    "Session idle timeout (hours) for privileged roles (SUPER_ADMIN, ADMIN, FINANCE) — security doc §2.",
  [SETTING_MFA_REQUIRED_FOR_PRIVILEGED]:
    "When true, SUPER_ADMIN and ADMIN accounts must enrol in TOTP MFA and pass a challenge at every login — security doc §2.",
  [SETTING_TRACKING_CONFIG]:
    "GPS tracking configuration (ping cadence, freshness windows, retention) — docs/live-gps-tracking.md.",
};

async function effectiveSettings(): Promise<SettingView[]> {
  const [staffRaw, privilegedRaw, mfaRaw, trackingRaw] = await Promise.all([
    readSettingValue(SETTING_IDLE_TIMEOUT_STAFF_HOURS),
    readSettingValue(SETTING_IDLE_TIMEOUT_PRIVILEGED_HOURS),
    readSettingValue(SETTING_MFA_REQUIRED_FOR_PRIVILEGED),
    readSettingValue(SETTING_TRACKING_CONFIG),
  ]);
  const tracking = resolveTrackingConfig(trackingRaw);
  return [
    {
      key: SETTING_IDLE_TIMEOUT_STAFF_HOURS,
      value: asSaneIdleHours(staffRaw, DEFAULT_IDLE_TIMEOUT_STAFF_HOURS),
      defaultValue: DEFAULT_IDLE_TIMEOUT_STAFF_HOURS,
      description: SETTING_DESCRIPTIONS[SETTING_IDLE_TIMEOUT_STAFF_HOURS],
      kind: "hours",
      bounds: { min: MIN_IDLE_TIMEOUT_HOURS, max: MAX_IDLE_TIMEOUT_HOURS },
    },
    {
      key: SETTING_IDLE_TIMEOUT_PRIVILEGED_HOURS,
      value: asSaneIdleHours(privilegedRaw, DEFAULT_IDLE_TIMEOUT_PRIVILEGED_HOURS),
      defaultValue: DEFAULT_IDLE_TIMEOUT_PRIVILEGED_HOURS,
      description: SETTING_DESCRIPTIONS[SETTING_IDLE_TIMEOUT_PRIVILEGED_HOURS],
      kind: "hours",
      bounds: { min: MIN_IDLE_TIMEOUT_HOURS, max: MAX_IDLE_TIMEOUT_HOURS },
    },
    {
      key: SETTING_MFA_REQUIRED_FOR_PRIVILEGED,
      value: typeof mfaRaw === "boolean" ? mfaRaw : DEFAULT_MFA_REQUIRED_FOR_PRIVILEGED,
      defaultValue: DEFAULT_MFA_REQUIRED_FOR_PRIVILEGED,
      description: SETTING_DESCRIPTIONS[SETTING_MFA_REQUIRED_FOR_PRIVILEGED],
      kind: "boolean",
    },
    {
      key: SETTING_TRACKING_CONFIG,
      value: tracking,
      defaultValue: TRACKING_CONFIG_DEFAULTS,
      description: SETTING_DESCRIPTIONS[SETTING_TRACKING_CONFIG],
      kind: "tracking-config",
      trackingFields: (Object.keys(TRACKING_CONFIG_DEFAULTS) as (keyof TrackingConfig)[]).map(
        (field) => ({
          field,
          value: tracking[field],
          defaultValue: TRACKING_CONFIG_DEFAULTS[field],
          min: TRACKING_CONFIG_FIELD_RULES[field].min,
          max: TRACKING_CONFIG_FIELD_RULES[field].max,
          integer: TRACKING_CONFIG_FIELD_RULES[field].integer,
        }),
      ),
    },
  ];
}

/** All four operator settings with effective values (settings.manage). */
export async function listSettings(actor: ActorContext): Promise<SettingView[]> {
  await requirePermAudited(actor, "settings.manage", "SystemSetting");
  return effectiveSettings();
}

function validateIdleHours(key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new DomainValidationError(`${key} must be a whole number of hours`);
  }
  if (value < MIN_IDLE_TIMEOUT_HOURS || value > MAX_IDLE_TIMEOUT_HOURS) {
    throw new DomainValidationError(
      `${key} must be between ${MIN_IDLE_TIMEOUT_HOURS} and ${MAX_IDLE_TIMEOUT_HOURS} hours`,
    );
  }
  return value;
}

/**
 * Update one setting (settings.manage). Validation is STRICT — these
 * values are live security gates, so anything malformed is rejected
 * outright (never silently defaulted the way readers fall back):
 * idle hours must be integers in 1–168, the MFA flag a boolean, and a
 * tracking.config patch is validated field-by-field and rejected as a
 * whole on any invalid field. Unknown keys are rejected. Every write
 * audits `settings.updated` with before/after effective values.
 */
export async function updateSetting(
  actor: ActorContext,
  key: string,
  value: unknown,
): Promise<SettingView> {
  await requirePermAudited(actor, "settings.manage", "SystemSetting");

  const before = (await effectiveSettings()).find((s) => s.key === key);
  if (!before) {
    throw new DomainValidationError(`Unknown setting: ${key}`);
  }

  let storedValue: unknown;
  let afterValue: unknown;
  if (key === SETTING_IDLE_TIMEOUT_STAFF_HOURS || key === SETTING_IDLE_TIMEOUT_PRIVILEGED_HOURS) {
    const hours = validateIdleHours(key, value);
    storedValue = hours;
    afterValue = hours;
  } else if (key === SETTING_MFA_REQUIRED_FOR_PRIVILEGED) {
    if (typeof value !== "boolean") {
      throw new DomainValidationError(`${key} must be true or false`);
    }
    storedValue = value;
    afterValue = value;
  } else if (key === SETTING_TRACKING_CONFIG) {
    const result = validateTrackingConfigPatch(value);
    if (!result.valid) {
      const first = Object.entries(result.errors)[0];
      throw new DomainValidationError(
        first ? `${first[0]}: ${first[1]}` : "Invalid tracking config patch",
      );
    }
    // Merge the validated patch over the CURRENT stored override (not
    // the resolved config) so untouched fields keep their stored state.
    const currentRaw = await readSettingValue(SETTING_TRACKING_CONFIG);
    const currentOverride =
      currentRaw !== null && typeof currentRaw === "object" && !Array.isArray(currentRaw)
        ? (currentRaw as Record<string, unknown>)
        : {};
    storedValue = { ...currentOverride, ...result.patch };
    afterValue = resolveTrackingConfig(storedValue);
  } else {
    throw new DomainValidationError(`Unknown setting: ${key}`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.systemSetting.upsert({
      where: { key },
      update: { value: storedValue as never, updatedById: actor.userId },
      create: {
        key,
        value: storedValue as never,
        description: SETTING_DESCRIPTIONS[key],
        updatedById: actor.userId,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        actorRole: actor.primaryRole,
        action: "settings.updated",
        entityType: "SystemSetting",
        entityId: key,
        before: { value: before.value as Prisma.InputJsonValue },
        after: { value: afterValue as Prisma.InputJsonValue },
      },
    });
  });

  const updated = (await effectiveSettings()).find((s) => s.key === key);
  return updated!;
}
