import type { ReactNode } from "react";

import {
  TONE_ICONS,
  type StatusTone,
  type ToneIconName,
} from "@/lib/status/status-tones";

/**
 * Tone icons (DS §2.4/§4) — small inline SVGs in the same Lucide-style
 * stroke language as the shell icon set (24px viewBox, stroke 1.8,
 * currentColor). They live here, not in layout/icons.tsx, because the
 * status system is a UI-primitive concern. Colour is never the only
 * channel: icons always accompany the label text (WCAG 1.4.1).
 */
const PATHS: Record<ToneIconName, ReactNode> = {
  "check-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.4 12.3 2.4 2.4 4.8-5.2" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.2 2" />
    </>
  ),
  "alert-octagon": (
    <>
      <path d="M7.9 2.5h8.2l5.4 5.4v8.2l-5.4 5.4H7.9L2.5 16.1V7.9z" />
      <path d="M12 8v4.5" />
      <path d="M12 16.2h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 7.8h.01" />
    </>
  ),
  "minus-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8" />
    </>
  ),
};

export function ToneIcon({
  tone,
  className = "h-[14px] w-[14px]",
}: {
  tone: StatusTone;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
    >
      {PATHS[TONE_ICONS[tone]]}
    </svg>
  );
}

/** Flag glyph for PriorityBadge (DS §4) — same stroke style. */
export function FlagIcon({ className = "h-[14px] w-[14px]" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
    >
      <path d="M5 21.5v-17" />
      <path d="M5 4.5c3.5-1.8 5.5 1.7 10.5 0v8.5c-5 1.7-7-1.8-10.5 0" />
    </svg>
  );
}
