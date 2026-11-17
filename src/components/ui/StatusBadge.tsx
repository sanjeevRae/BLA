import {
  statusTone,
  TONE_CLASSES,
  TONE_HEX,
  TONE_TEXT_CLASSES,
  type StatusDomain,
  type StatusTone,
} from "@/lib/status/status-tones";
import { statusLabel } from "@/lib/status/labels";
import { FlagIcon, ToneIcon } from "./ToneIcon";

/**
 * StatusBadge v3 (DS §4): tint background, status text colour, tone
 * icon (14px) + friendly label. Two densities:
 * - `pill` (default; existing call sites unchanged) — detail headers,
 *   cards, field surfaces.
 * - `compact` — dot + label for dense table rows.
 * Colour is redundant encoding: the icon and the word always render.
 */
export function StatusBadge({
  domain = "generic",
  status,
  className = "",
  density = "pill",
}: {
  domain?: StatusDomain;
  status: string;
  className?: string;
  density?: "pill" | "compact";
}) {
  const tone = statusTone(domain, status);
  const label = statusLabel(domain, status);
  if (density === "compact") {
    return (
      <span
        className={`inline-flex items-center gap-1.5 text-[12.5px] font-[550] ${TONE_TEXT_CLASSES[tone]} ${className}`}
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: TONE_HEX[tone].text }}
        />
        {label}
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-[550] ${TONE_CLASSES[tone]} ${className}`}
    >
      <ToneIcon tone={tone} />
      {label}
    </span>
  );
}

const PRIORITY_TONES: Readonly<Record<string, StatusTone>> = {
  CRITICAL: "danger",
  HIGH: "danger",
  MEDIUM: "warning",
  LOW: "neutral",
};

/**
 * PriorityBadge (DS §4) — a SEPARATE element from StatusBadge, never
 * merged into it: flag icon + word; HIGH/CRITICAL → Failed tone,
 * MEDIUM → Pending, LOW → Neutral.
 */
export function PriorityBadge({
  priority,
  className = "",
}: {
  priority: string;
  className?: string;
}) {
  const tone = PRIORITY_TONES[priority] ?? "neutral";
  const label = statusLabel("generic", priority);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-[550] ${TONE_CLASSES[tone]} ${className}`}
    >
      <FlagIcon />
      {label}
    </span>
  );
}
