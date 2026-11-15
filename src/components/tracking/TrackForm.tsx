"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { inputClass, primaryButtonClass } from "@/components/warehouses/ui";

/** Public tracking lookup form: the tracking code alone is the
 *  credential for the minimal public projection (security doc §7). */
export function TrackForm({ initialValue = "" }: { initialValue?: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initialValue);
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const code = value.trim().toUpperCase();
    if (code) router.push(`/track/${encodeURIComponent(code)}`);
  }
  return (
    <form onSubmit={onSubmit} className="flex gap-2">
      <input
        className={inputClass}
        placeholder="BLA-0000000000"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="Tracking code"
      />
      <button type="submit" className={primaryButtonClass}>
        Track
      </button>
    </form>
  );
}
