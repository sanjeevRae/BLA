import { StatusBadge as SharedStatusBadge } from "@/components/ui/StatusBadge";

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

export function StatusBadge({ status }: { status: string }) {
  return <SharedStatusBadge domain="generic" status={status} />;
}
