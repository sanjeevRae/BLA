import { statusLabel, statusTone, TONE_CLASSES, type StatusDomain } from "@/lib/status/status-tones";

export function StatusBadge({ domain = "generic", status, className = "" }: { domain?: StatusDomain; status: string; className?: string }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${TONE_CLASSES[statusTone(domain, status)]} ${className}`}>{statusLabel(status)}</span>;
}
