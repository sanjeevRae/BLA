/** Shared display helpers for the Phase 3 modules (console tokens). */

/** Integer paisa string → "NPR 1,234.56". */
export function formatPaisa(paisa: string | bigint): string {
  const value = typeof paisa === "bigint" ? paisa : BigInt(paisa);
  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const rupees = abs / BigInt(100);
  const remainder = abs % BigInt(100);
  const grouped = rupees.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}NPR ${grouped}.${remainder.toString().padStart(2, "0")}`;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const GOOD = new Set(["APPROVED", "DELIVERED", "ACTIVE", "CONFIRMED", "PAID"]);
const BAD = new Set(["REJECTED", "CANCELLED", "SUSPENDED", "INACTIVE"]);
const WARN = new Set([
  "PENDING",
  "PENDING_VERIFICATION",
  "UNDER_REVIEW",
  "SUBMITTED",
  "UNROUTED",
  "PARTIALLY_DELIVERED",
]);

export function StatusBadge({ status }: { status: string }) {
  const classes = GOOD.has(status)
    ? "bg-greenbg text-green"
    : BAD.has(status)
      ? "bg-[#fdecec] text-red"
      : WARN.has(status)
        ? "bg-orangebg text-orange"
        : "bg-cream text-slate2";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${classes}`}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}
