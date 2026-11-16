import type { ReactNode } from "react";

import type { NavIconName } from "@/lib/navigation/registry";

/**
 * The shell's icon set (V2 Phase 1): minimal 24px stroke icons drawn
 * in the Lucide style — no icon font, no extra dependency, no
 * decorative colour. Icons inherit `currentColor`.
 */
const PATHS: Record<NavIconName, ReactNode> = {
  home: (
    <>
      <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
    </>
  ),
  tasks: (
    <>
      <path d="m9 6 2 2 4-4" />
      <path d="M9 12h11" />
      <path d="M9 18h11" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </>
  ),
  bell: (
    <>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </>
  ),
  package: (
    <>
      <path d="M12 3 4 7v10l8 4 8-4V7z" />
      <path d="m4 7 8 4 8-4" />
      <path d="M12 11v10" />
    </>
  ),
  warehouse: (
    <>
      <path d="M3 21V9l9-5 9 5v12" />
      <path d="M7 21v-8h10v8" />
      <path d="M7 17h10" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2 20h20z" />
      <path d="M12 10v4" />
      <path d="M12 17.5h.01" />
    </>
  ),
  ticket: (
    <>
      <path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2.5 2.5 0 0 0 0 5v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2.5 2.5 0 0 0 0-5z" />
      <path d="M13 6v2M13 11v2M13 16v2" />
    </>
  ),
  store: (
    <>
      <path d="M4 7 5.5 3h13L20 7" />
      <path d="M4 7h16v3a2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-5 0z" />
      <path d="M5 12.5V21h14v-8.5" />
      <path d="M9.5 21v-5h5v5" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5" />
      <path d="M16 5.2a3.5 3.5 0 0 1 0 5.6" />
      <path d="M17.5 15.4c2 .6 3.4 2.1 4 4.6" />
    </>
  ),
  truck: (
    <>
      <path d="M2 6h12v11H2z" />
      <path d="M14 10h4l3 3v4h-7" />
      <circle cx="6.5" cy="17.5" r="1.8" />
      <circle cx="17" cy="17.5" r="1.8" />
    </>
  ),
  car: (
    <>
      <path d="m5 11 1.7-4.2A2 2 0 0 1 8.6 5.5h6.8a2 2 0 0 1 1.9 1.3L19 11" />
      <path d="M3 11h18v6H3z" />
      <circle cx="7" cy="17.5" r="1.8" />
      <circle cx="17" cy="17.5" r="1.8" />
    </>
  ),
  coins: (
    <>
      <circle cx="9" cy="9" r="6" />
      <path d="M14.5 5.6a6 6 0 1 1-8.9 8.9" />
    </>
  ),
  sliders: (
    <>
      <path d="M5 6h9M18 6h1M5 12h3M12 12h7M5 18h11M20 18h-1" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </>
  ),
  chart: (
    <>
      <path d="M4 4v16h16" />
      <path d="M8 16v-5M12 16V8M16 16v-8" />
    </>
  ),
  scan: (
    <>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <path d="M4 12h16" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13 5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <path d="M3 13h5l1.5 2.5h5L16 13h5" />
    </>
  ),
  boxes: (
    <>
      <path d="M3 8.5 12 4l9 4.5V20H3z" />
      <path d="m3 8.5 9 4 9-4M12 12.5V20" />
      <path d="m7.5 6.2 9 4.5" />
    </>
  ),
  swap: (
    <>
      <path d="M4 7h13l-3-3" />
      <path d="M20 17H7l3 3" />
    </>
  ),
  hand: (
    <>
      <path d="m11 11-6.5 4.5a2 2 0 0 0 2.7 3L13 14" />
      <path d="m13 10 6.5 4.5a2 2 0 0 1-2.7 3L11 13" />
      <path d="m8.5 8.5 3-3 2.5 2.5" />
    </>
  ),
  undo: (
    <>
      <path d="M8 5 4 9l4 4" />
      <path d="M4 9h9a7 7 0 0 1 0 14h-3" />
    </>
  ),
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18" />
      <path d="M16.5 15h.01" />
    </>
  ),
  file: (
    <>
      <path d="M6 2h8l4 4v16H6z" />
      <path d="M14 2v4h4" />
      <path d="M9 12h6M9 16h6" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c.9-3.4 3.7-5.2 7-5.2s6.1 1.8 7 5.2" />
    </>
  ),
  map: (
    <>
      <path d="M12 21s-7-5.3-7-11a7 7 0 0 1 14 0c0 5.7-7 11-7 11z" />
      <circle cx="12" cy="10" r="2.6" />
    </>
  ),
};

export function NavIcon({
  name,
  className = "h-[18px] w-[18px]",
}: {
  name: NavIconName;
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
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}
