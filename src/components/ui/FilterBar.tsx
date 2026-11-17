import type { MouseEventHandler, ReactNode } from "react";
import Link from "next/link";

/**
 * FilterBar (V3 Step 9, DS §7.7) — server-safe presentational filter
 * chrome: NO "use client", NO hooks. Pages keep owning their query
 * behaviour entirely (these components change no filter semantics);
 * a chip is either a Link (href variant — the server-page pattern,
 * filters live in the URL) or a plain button (onClick variant — the
 * client-page pattern).
 *
 * DS §7.7 styling: inactive chip = surface-2 fill, ink label; active
 * chip = primary-light fill + primary-dark label + a check glyph.
 * Chips are pill-shaped (pill radius is reserved for badges and
 * filter chips, DS §5) with a ≥32px hit height.
 */

const CHIP_BASE =
  "inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-transparent px-3 text-[13px] font-medium";
const CHIP_ACTIVE = "bg-primary-light text-primary-dark";
const CHIP_INACTIVE = "bg-surface-2 text-ink hover:text-primary-dark";

function chipClass(active: boolean, className?: string): string {
  return `${CHIP_BASE} ${active ? CHIP_ACTIVE : CHIP_INACTIVE} ${className ?? ""}`;
}

function ChipLabel({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <>
      {active ? (
        <span aria-hidden="true" data-filter-chip-check="">
          ✓
        </span>
      ) : null}
      {children}
    </>
  );
}

export function FilterBar({
  children,
  ariaLabel = "Filters",
  className,
}: {
  children: ReactNode;
  /** Accessible name for the group (rendered as aria-label). */
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`flex flex-wrap items-center gap-2 ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

export interface FilterChipProps {
  children: ReactNode;
  active?: boolean;
  /** Link variant: renders a next/link anchor. Mutually exclusive with onClick. */
  href?: string;
  /** Button variant: renders a <button type="button">. Mutually exclusive with href. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  className?: string;
}

export function FilterChip({
  children,
  active = false,
  href,
  onClick,
  className,
}: FilterChipProps) {
  if (href !== undefined) {
    return (
      <Link
        href={href}
        aria-current={active ? "true" : undefined}
        className={chipClass(active, className)}
      >
        <ChipLabel active={active}>{children}</ChipLabel>
      </Link>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={chipClass(active, className)}
    >
      <ChipLabel active={active}>{children}</ChipLabel>
    </button>
  );
}

export interface FilterClearAllProps {
  children?: ReactNode;
  /** Link variant: renders a next/link anchor. Mutually exclusive with onClick. */
  href?: string;
  /** Button variant: renders a <button type="button">. Mutually exclusive with href. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  className?: string;
}

/**
 * FilterClearAll — the "Clear all" affordance (DS §7.6/§7.7). Callers
 * render it ONLY when a filter is active; the component itself just
 * renders what it is given, as a link (href) or a button (onClick).
 */
export function FilterClearAll({
  children = "Clear all",
  href,
  onClick,
  className,
}: FilterClearAllProps) {
  const classes = `inline-flex min-h-[32px] items-center px-2 text-[13px] font-semibold text-primary underline-offset-2 hover:underline ${className ?? ""}`;
  if (href !== undefined) {
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={classes}>
      {children}
    </button>
  );
}
