import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { DomainValidationError } from "@/lib/errors";
import {
  billableWeightKg,
  shippingChargePaisa,
  volumetricWeightKg,
} from "@/lib/bookings/pricing-math";

type Tx = Prisma.TransactionClient;

/**
 * Pricing resolution (docs/business-requirements.md §6.3): rates are
 * configuration rows, never code. Resolution picks the most specific
 * active, in-date rule for (service, origin area, destination area,
 * billable weight); the winning rule and the computed charge are
 * snapshotted onto the Shipment at booking time, so later tariff edits
 * never rewrite history.
 */

export interface ResolvedPricing {
  rule: {
    id: string;
    baseRatePaisa: bigint;
    perKgRatePaisa: bigint;
    volumetricDivisor: number;
  };
  shippingChargePaisa: bigint;
}

function specificity(rule: {
  originServiceAreaId: string | null;
  destinationServiceAreaId: string | null;
}): number {
  return (rule.originServiceAreaId ? 2 : 0) + (rule.destinationServiceAreaId ? 2 : 0);
}

export async function resolvePricing(
  tx: Tx,
  args: {
    shippingServiceId: string;
    originServiceAreaId: string | null;
    destinationServiceAreaId: string | null;
    totalBillableWeightKg: Prisma.Decimal;
  },
): Promise<ResolvedPricing> {
  const now = new Date();
  const candidates = await tx.pricingRule.findMany({
    where: {
      shippingServiceId: args.shippingServiceId,
      isActive: true,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      AND: [
        {
          OR: [
            { originServiceAreaId: null },
            ...(args.originServiceAreaId
              ? [{ originServiceAreaId: args.originServiceAreaId }]
              : []),
          ],
        },
        {
          OR: [
            { destinationServiceAreaId: null },
            ...(args.destinationServiceAreaId
              ? [{ destinationServiceAreaId: args.destinationServiceAreaId }]
              : []),
          ],
        },
      ],
    },
  });
  const inBand = candidates.filter((rule) => {
    if (rule.minWeightKg && args.totalBillableWeightKg.lt(rule.minWeightKg)) return false;
    if (rule.maxWeightKg && args.totalBillableWeightKg.gt(rule.maxWeightKg)) return false;
    return true;
  });
  inBand.sort((a, b) => specificity(b) - specificity(a));
  const rule = inBand[0];
  if (!rule) {
    throw new DomainValidationError(
      "No active pricing rule covers this service and route — ask an administrator to configure the tariff before booking",
    );
  }
  return {
    rule: {
      id: rule.id,
      baseRatePaisa: rule.baseRatePaisa,
      perKgRatePaisa: rule.perKgRatePaisa,
      volumetricDivisor: rule.volumetricDivisor,
    },
    shippingChargePaisa: shippingChargePaisa(
      rule.baseRatePaisa,
      rule.perKgRatePaisa,
      args.totalBillableWeightKg,
    ),
  };
}

/** Per-parcel weights from a booked line: declared per-unit weight plus
 *  volumetric weight when dimensions were supplied. */
export function parcelWeights(args: {
  declaredWeightKg: Prisma.Decimal;
  lengthCm?: Prisma.Decimal | null;
  widthCm?: Prisma.Decimal | null;
  heightCm?: Prisma.Decimal | null;
  volumetricDivisor: number;
}): { volumetricKg: Prisma.Decimal | null; billableKg: Prisma.Decimal } {
  const volumetricKg =
    args.lengthCm && args.widthCm && args.heightCm
      ? volumetricWeightKg(args.lengthCm, args.widthCm, args.heightCm, args.volumetricDivisor)
      : null;
  return { volumetricKg, billableKg: billableWeightKg(args.declaredWeightKg, volumetricKg) };
}

/** Active shipping services for booking forms (reference data). */
export async function listShippingServices() {
  return prisma.shippingService.findMany({
    where: { isActive: true },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true, estimatedDaysMin: true, estimatedDaysMax: true },
  });
}
