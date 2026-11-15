"use client";

import { subtleButtonClass } from "@/components/warehouses/ui";

export function PrintButton() {
  return (
    <button type="button" className={subtleButtonClass} onClick={() => window.print()}>
      Print label
    </button>
  );
}
