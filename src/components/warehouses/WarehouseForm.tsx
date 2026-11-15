"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import {
  createWarehouseAction,
  updateWarehouseAction,
} from "@/server/actions/warehouses";
import type {
  CreateWarehouseInput,
  WarehouseView,
} from "@/server/services/warehouses";
import { WAREHOUSE_TYPES } from "@/lib/warehouses/codes";
import { ErrorBox, inputClass, labelClass, primaryButtonClass } from "./ui";

const TYPE_LABELS: Record<string, string> = {
  MAIN: "Main warehouse",
  REGIONAL: "Regional warehouse",
  LOCAL_HUB: "Local delivery hub",
  COLLECTION_CENTER: "Collection center",
  RETURN_CENTER: "Return processing center",
};

function numOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Create / edit warehouse master data. The code is set at creation and
 * never editable again (immutable — it is printed on labels). In edit
 * mode for a warehouse-scoped actor the server restricts which fields
 * may change; the form simply submits and surfaces the server's answer.
 */
export function WarehouseForm({
  basePath,
  warehouse,
}: {
  basePath: string;
  warehouse?: WarehouseView;
}) {
  const router = useRouter();
  const editing = warehouse !== undefined;
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [code, setCode] = useState(warehouse?.code ?? "");
  const [name, setName] = useState(warehouse?.name ?? "");
  const [type, setType] = useState(warehouse?.type ?? "REGIONAL");
  const [district, setDistrict] = useState(warehouse?.district ?? "");
  const [city, setCity] = useState(warehouse?.city ?? "");
  const [province, setProvince] = useState(warehouse?.province ?? "");
  const [contactPhone, setContactPhone] = useState(warehouse?.contactPhone ?? "");
  const [email, setEmail] = useState(warehouse?.email ?? "");
  const [capacityPackages, setCapacityPackages] = useState(
    warehouse?.capacityPackages != null ? String(warehouse.capacityPackages) : "",
  );
  const [capacityWeightKg, setCapacityWeightKg] = useState(
    warehouse?.capacityWeightKg ?? "",
  );
  const [addressLine1, setAddressLine1] = useState(warehouse?.address?.addressLine1 ?? "");
  const [addressLine2, setAddressLine2] = useState(warehouse?.address?.addressLine2 ?? "");
  const [postalCode, setPostalCode] = useState(warehouse?.address?.postalCode ?? "");
  const [latitude, setLatitude] = useState(warehouse?.address?.latitude ?? "");
  const [longitude, setLongitude] = useState(warehouse?.address?.longitude ?? "");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (editing) {
        const result = await updateWarehouseAction(warehouse.id, {
          name,
          type: type as CreateWarehouseInput["type"],
          district,
          city,
          province,
          contactPhone: contactPhone || null,
          email: email || null,
          capacityPackages: numOrNull(capacityPackages),
          capacityWeightKg: numOrNull(capacityWeightKg),
          address: {
            addressLine1,
            addressLine2: addressLine2 || null,
            postalCode: postalCode || null,
            latitude: numOrNull(latitude),
            longitude: numOrNull(longitude),
          },
        });
        if (!result.success) {
          setError(result.error);
          setSubmitting(false);
          return;
        }
        router.refresh();
        setSubmitting(false);
      } else {
        const result = await createWarehouseAction({
          code: code.trim().toUpperCase(),
          name,
          type: type as CreateWarehouseInput["type"],
          district,
          city,
          province,
          contactPhone: contactPhone || null,
          email: email || null,
          capacityPackages: numOrNull(capacityPackages),
          capacityWeightKg: numOrNull(capacityWeightKg),
          address: {
            addressLine1,
            addressLine2: addressLine2 || null,
            postalCode: postalCode || null,
            latitude: numOrNull(latitude),
            longitude: numOrNull(longitude),
          },
        });
        if (!result.success) {
          setError(result.error);
          setSubmitting(false);
          return;
        }
        router.push(`${basePath}/warehouses/${result.data.id}`);
      }
    } catch {
      setError("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <label htmlFor="wh-code" className={labelClass}>
          Code {editing && "(immutable)"}
        </label>
        <input
          id="wh-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={editing}
          placeholder="WH-KTM-01"
          className={inputClass}
          required={!editing}
        />
      </div>
      <div>
        <label htmlFor="wh-name" className={labelClass}>
          Name
        </label>
        <input
          id="wh-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
          required
        />
      </div>
      <div>
        <label htmlFor="wh-type" className={labelClass}>
          Type
        </label>
        <select
          id="wh-type"
          value={type}
          onChange={(e) => setType(e.target.value)}
          className={inputClass}
        >
          {WAREHOUSE_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="wh-district" className={labelClass}>
          District (drives routing)
        </label>
        <input
          id="wh-district"
          value={district}
          onChange={(e) => setDistrict(e.target.value)}
          className={inputClass}
          required
        />
      </div>
      <div>
        <label htmlFor="wh-city" className={labelClass}>
          City
        </label>
        <input
          id="wh-city"
          value={city}
          onChange={(e) => setCity(e.target.value)}
          className={inputClass}
          required
        />
      </div>
      <div>
        <label htmlFor="wh-province" className={labelClass}>
          Province
        </label>
        <input
          id="wh-province"
          value={province}
          onChange={(e) => setProvince(e.target.value)}
          className={inputClass}
          required
        />
      </div>
      <div>
        <label htmlFor="wh-phone" className={labelClass}>
          Contact number
        </label>
        <input
          id="wh-phone"
          value={contactPhone}
          onChange={(e) => setContactPhone(e.target.value)}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="wh-email" className={labelClass}>
          Warehouse email
        </label>
        <input
          id="wh-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="wh-cap" className={labelClass}>
          Capacity (packages)
        </label>
        <input
          id="wh-cap"
          type="number"
          min={1}
          value={capacityPackages}
          onChange={(e) => setCapacityPackages(e.target.value)}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="wh-capkg" className={labelClass}>
          Capacity (kg, optional)
        </label>
        <input
          id="wh-capkg"
          type="number"
          min={0}
          step="0.01"
          value={capacityWeightKg}
          onChange={(e) => setCapacityWeightKg(e.target.value)}
          className={inputClass}
        />
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="wh-addr1" className={labelClass}>
          Address line 1
        </label>
        <input
          id="wh-addr1"
          value={addressLine1}
          onChange={(e) => setAddressLine1(e.target.value)}
          className={inputClass}
          required
        />
      </div>
      <div>
        <label htmlFor="wh-addr2" className={labelClass}>
          Address line 2
        </label>
        <input
          id="wh-addr2"
          value={addressLine2}
          onChange={(e) => setAddressLine2(e.target.value)}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="wh-postal" className={labelClass}>
          Postal code
        </label>
        <input
          id="wh-postal"
          value={postalCode}
          onChange={(e) => setPostalCode(e.target.value)}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="wh-lat" className={labelClass}>
          Latitude
        </label>
        <input
          id="wh-lat"
          type="number"
          step="0.0000001"
          value={latitude}
          onChange={(e) => setLatitude(e.target.value)}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="wh-lng" className={labelClass}>
          Longitude
        </label>
        <input
          id="wh-lng"
          type="number"
          step="0.0000001"
          value={longitude}
          onChange={(e) => setLongitude(e.target.value)}
          className={inputClass}
        />
      </div>
      {error !== null && (
        <div className="sm:col-span-2">
          <ErrorBox message={error} />
        </div>
      )}
      <div className="sm:col-span-2">
        <button type="submit" disabled={submitting} className={primaryButtonClass}>
          {submitting ? "Saving…" : editing ? "Save changes" : "Create warehouse (starts inactive)"}
        </button>
      </div>
    </form>
  );
}
