import "server-only";

import { prisma } from "@/lib/db/prisma";
import {
  TRACKING_IP_FAILURE_LIMIT,
  TRACKING_IP_FAILURE_WINDOW_MS,
} from "@/lib/deliveries/domain";

/**
 * Shared bookkeeping for the public tracking surfaces (Phase 10,
 * P3-2 / P6-R6 remainder; docs/security-architecture.md §7).
 *
 * The per-tracking-id lockout (TRACKING_DETAIL_MAX_FAILURES) stops
 * guessing against ONE parcel. This module is the per-IP dimension:
 * failed attempts from one client IP across ALL tracking ids share
 * one budget (TRACKING_IP_FAILURE_LIMIT per window). Every public
 * entry point — basic tracking, detailed tracking, complaint
 * creation — checks the budget in its service, so no route can
 * bypass it, and every denial stays the surface's own
 * indistinguishable NotFoundError: the limiter never answers with a
 * distinguishable 429.
 *
 * The IP comes from the trusted forwarding header (see
 * src/lib/auth/client-ip.ts for the trust assumption). When no IP
 * is available (internal calls, tests) the limiter is inert —
 * exactly like the login per-IP throttle.
 */

export interface TrackingRequestMeta {
  ipAddress?: string | null;
}

/** True when the IP has exhausted its failed-attempt budget. */
export async function isTrackingIpBudgetExceeded(
  ipAddress: string | null | undefined,
): Promise<boolean> {
  if (!ipAddress) return false;
  const failures = await prisma.trackingAccessAttempt.count({
    where: {
      ipAddress,
      succeeded: false,
      createdAt: { gt: new Date(Date.now() - TRACKING_IP_FAILURE_WINDOW_MS) },
    },
  });
  return failures >= TRACKING_IP_FAILURE_LIMIT;
}
