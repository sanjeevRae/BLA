"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import {
  createLocationAction,
  createZoneAction,
  updateLocationAction,
  updateZoneAction,
} from "@/server/actions/warehouses";
import type { WarehouseZoneView } from "@/server/services/warehouses";
import { ZONE_KINDS } from "@/lib/warehouses/codes";
import {
  ErrorBox,
  SectionCard,
  inputClass,
  labelClass,
  primaryButtonClass,
  subtleButtonClass,
} from "./ui";

const KIND_LABELS: Record<string, string> = {
  RECEIVING: "Receiving",
  INSPECTION: "Inspection",
  SORTING: "Sorting",
  STORAGE: "Storage",
  DISPATCH: "Dispatch",
  DAMAGED: "Damaged",
  RETURNS: "Returns",
};

/** Zones + storage locations for one warehouse. Locations are created
 *  and deactivated, never renamed — a location's full code is printed
 *  on physical labels. */
export function ZonesPanel({
  warehouseId,
  zones,
  canManage,
}: {
  warehouseId: string;
  zones: WarehouseZoneView[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [zoneName, setZoneName] = useState("");
  const [zoneKind, setZoneKind] = useState<string>("STORAGE");
  const [zoneCode, setZoneCode] = useState("");

  const [locForms, setLocForms] = useState<Record<string, { rack: string; shelf: string; bin: string }>>({});

  async function guard(run: () => Promise<{ success: boolean; error?: string }>) {
    setError(null);
    setBusy(true);
    try {
      const result = await run();
      if (!result.success) {
        setError(result.error ?? "Something went wrong.");
        setBusy(false);
        return;
      }
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  async function onAddZone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await guard(() =>
      createZoneAction(warehouseId, {
        name: zoneName,
        kind: zoneKind as (typeof ZONE_KINDS)[number],
        ...(zoneCode.trim() ? { code: zoneCode.trim().toUpperCase() } : {}),
      }),
    );
    setZoneName("");
    setZoneCode("");
  }

  async function onAddLocation(event: FormEvent<HTMLFormElement>, zoneId: string) {
    event.preventDefault();
    const form = locForms[zoneId] ?? { rack: "", shelf: "", bin: "" };
    await guard(() =>
      createLocationAction(zoneId, {
        rack: form.rack,
        shelf: form.shelf || null,
        bin: form.bin || null,
      }),
    );
    setLocForms((prev) => ({ ...prev, [zoneId]: { rack: "", shelf: "", bin: "" } }));
  }

  return (
    <SectionCard title={`Zones & storage locations (${zones.length})`}>
      <div className="flex flex-col gap-5">
        {zones.map((zone) => (
          <div key={zone.id} className="rounded-md border border-line">
            <div className="flex flex-wrap items-center gap-2 border-b border-line bg-page px-3 py-2">
              <span className="font-mono text-[12px] font-semibold text-ink">{zone.code}</span>
              <span className="text-[13px] font-medium text-ink">{zone.name}</span>
              <span className="rounded-full bg-cream px-2 py-0.5 text-[11px] font-semibold text-slate2">
                {KIND_LABELS[zone.kind] ?? zone.kind}
              </span>
              {!zone.isActive && (
                <span className="rounded-full bg-[#fdecec] px-2 py-0.5 text-[11px] font-semibold text-red">
                  Inactive
                </span>
              )}
              {canManage && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    guard(() => updateZoneAction(zone.id, { isActive: !zone.isActive }))
                  }
                  className={`${subtleButtonClass} ml-auto`}
                >
                  {zone.isActive ? "Deactivate zone" : "Reactivate zone"}
                </button>
              )}
            </div>
            <div className="px-3 py-2">
              {zone.locations.length === 0 ? (
                <p className="text-[12px] text-faint">No storage locations yet.</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {zone.locations.map((location) => (
                    <li
                      key={location.id}
                      className={`flex items-center gap-2 rounded-md border border-line px-2 py-1 font-mono text-[11px] ${
                        location.isActive ? "text-ink" : "text-faint line-through"
                      }`}
                    >
                      {location.fullCode}
                      {canManage && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            guard(() =>
                              updateLocationAction(location.id, {
                                isActive: !location.isActive,
                              }),
                            )
                          }
                          className="font-sans text-[11px] font-semibold text-brand"
                        >
                          {location.isActive ? "deactivate" : "activate"}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {canManage && zone.isActive && (
                <form
                  onSubmit={(e) => onAddLocation(e, zone.id)}
                  className="mt-2 flex flex-wrap items-end gap-2"
                >
                  <div>
                    <label className={labelClass} htmlFor={`rack-${zone.id}`}>
                      Rack
                    </label>
                    <input
                      id={`rack-${zone.id}`}
                      value={locForms[zone.id]?.rack ?? ""}
                      onChange={(e) =>
                        setLocForms((prev) => ({
                          ...prev,
                          [zone.id]: { ...(prev[zone.id] ?? { shelf: "", bin: "" }), rack: e.target.value },
                        }))
                      }
                      className={`${inputClass} w-[90px]`}
                      placeholder="03"
                      required
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor={`shelf-${zone.id}`}>
                      Shelf
                    </label>
                    <input
                      id={`shelf-${zone.id}`}
                      value={locForms[zone.id]?.shelf ?? ""}
                      onChange={(e) =>
                        setLocForms((prev) => ({
                          ...prev,
                          [zone.id]: { ...(prev[zone.id] ?? { rack: "", bin: "" }), shelf: e.target.value },
                        }))
                      }
                      className={`${inputClass} w-[90px]`}
                      placeholder="02"
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor={`bin-${zone.id}`}>
                      Bin
                    </label>
                    <input
                      id={`bin-${zone.id}`}
                      value={locForms[zone.id]?.bin ?? ""}
                      onChange={(e) =>
                        setLocForms((prev) => ({
                          ...prev,
                          [zone.id]: { ...(prev[zone.id] ?? { rack: "", shelf: "" }), bin: e.target.value },
                        }))
                      }
                      className={`${inputClass} w-[90px]`}
                      placeholder="01"
                    />
                  </div>
                  <button type="submit" disabled={busy} className={subtleButtonClass}>
                    Add location
                  </button>
                </form>
              )}
            </div>
          </div>
        ))}
      </div>

      {canManage && (
        <form onSubmit={onAddZone} className="mt-5 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="zone-name" className={labelClass}>
              New zone name
            </label>
            <input
              id="zone-name"
              value={zoneName}
              onChange={(e) => setZoneName(e.target.value)}
              className={inputClass}
              required
            />
          </div>
          <div>
            <label htmlFor="zone-kind" className={labelClass}>
              Kind
            </label>
            <select
              id="zone-kind"
              value={zoneKind}
              onChange={(e) => setZoneKind(e.target.value)}
              className={inputClass}
            >
              {ZONE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="zone-code" className={labelClass}>
              Code (optional)
            </label>
            <input
              id="zone-code"
              value={zoneCode}
              onChange={(e) => setZoneCode(e.target.value)}
              className={inputClass}
              placeholder="ZONE-STO"
            />
          </div>
          <button type="submit" disabled={busy} className={primaryButtonClass}>
            Add zone
          </button>
        </form>
      )}
      {error !== null && (
        <div className="mt-3">
          <ErrorBox message={error} />
        </div>
      )}
    </SectionCard>
  );
}
