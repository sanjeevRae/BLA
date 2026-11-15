import { Prisma } from "@prisma/client";

/**
 * Pure pricing arithmetic (docs/business-requirements.md §6.2–§6.3).
 * Declared, actual, volumetric and billable weights are stored
 * separately and never conflated; money is integer paisa (BigInt).
 * The rates themselves come from PricingRule rows — configuration,
 * never code.
 */

export function volumetricWeightKg(
  lengthCm: Prisma.Decimal,
  widthCm: Prisma.Decimal,
  heightCm: Prisma.Decimal,
  divisor: number,
): Prisma.Decimal {
  return lengthCm
    .mul(widthCm)
    .mul(heightCm)
    .div(divisor)
    .toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP);
}

export function billableWeightKg(
  declaredWeightKg: Prisma.Decimal,
  volumetricKg: Prisma.Decimal | null,
): Prisma.Decimal {
  if (!volumetricKg) return declaredWeightKg;
  return Prisma.Decimal.max(declaredWeightKg, volumetricKg);
}

/** base + per-kg × billable, rounded to the nearest paisa. */
export function shippingChargePaisa(
  baseRatePaisa: bigint,
  perKgRatePaisa: bigint,
  billableKg: Prisma.Decimal,
): bigint {
  const weightCharge = new Prisma.Decimal(perKgRatePaisa.toString())
    .mul(billableKg)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  return baseRatePaisa + BigInt(weightCharge.toString());
}

/**
 * Split an integer paisa total across `parts` parcels as evenly as
 * possible; the remainder goes one paisa at a time to the earliest
 * parcels so the parts always sum EXACTLY to the total (COD money is
 * never created or lost by rounding).
 */
export function splitPaisa(total: bigint, parts: number): bigint[] {
  if (parts <= 0) return [];
  const count = BigInt(parts);
  const base = total / count;
  const remainder = total % count;
  return Array.from({ length: parts }, (_, i) =>
    base + (BigInt(i) < remainder ? BigInt(1) : BigInt(0)),
  );
}
