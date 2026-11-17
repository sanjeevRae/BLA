/**
 * TrendIndicator (DS §7.5) — the honest delta inside a StatCard.
 *
 * Renders a small inline SVG arrow, the signed delta, and the window
 * label ("vs yesterday"). Colour follows MEANING, not direction: the
 * success tone when the movement is in `goodDirection`, the danger
 * tone when it is against it. A zero delta makes no colour claim at
 * all — it renders "0 · label" in ink-2 with no arrow (DS §1.5:
 * honesty is a design token). Numerals are tabular. The visible text
 * is aria-hidden; the root carries an aria-label spelling out the
 * meaning for screen readers.
 */
export function TrendIndicator({
  delta,
  goodDirection,
  label,
  formatDelta,
}: {
  delta: number;
  goodDirection: "up" | "down";
  label: string;
  formatDelta?: (n: number) => string;
}) {
  const formatAbs = (n: number) =>
    formatDelta ? formatDelta(Math.abs(n)) : String(Math.abs(n));

  if (delta === 0) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[12.5px] tabular-nums text-ink-2"
        aria-label={`No change ${label}`}
      >
        <span aria-hidden="true">{`0 · ${label}`}</span>
      </span>
    );
  }

  const isUp = delta > 0;
  const isGood = isUp === (goodDirection === "up");
  const signed = formatDelta
    ? formatDelta(delta)
    : `${delta > 0 ? "+" : "−"}${Math.abs(delta)}`;
  const ariaLabel = `${isUp ? "Increased" : "Decreased"} by ${formatAbs(delta)} ${label} — ${
    isGood ? "an improvement" : "a decline"
  }`;

  return (
    <span
      className={`inline-flex items-center gap-1 text-[12.5px] font-[550] tabular-nums ${
        isGood ? "text-success" : "text-danger"
      }`}
      aria-label={ariaLabel}
    >
      <span aria-hidden="true" className="inline-flex items-center gap-1">
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 12 12"
          className="h-[10px] w-[10px] shrink-0"
          fill="currentColor"
        >
          {isUp ? <path d="M6 1.5 11 10H1z" /> : <path d="M6 10.5 1 2h10z" />}
        </svg>
        <span>{signed}</span>
        <span className="font-normal text-ink-2">{label}</span>
      </span>
    </span>
  );
}
