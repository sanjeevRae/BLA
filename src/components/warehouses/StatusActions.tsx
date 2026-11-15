"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  activateWarehouseAction,
  deactivateWarehouseAction,
} from "@/server/actions/warehouses";
import { ErrorBox, dangerButtonClass, primaryButtonClass } from "./ui";

/** Activate / deactivate controls. There is deliberately no delete:
 *  warehouses are deactivated, never deleted (workflow §6). */
export function StatusActions({
  warehouseId,
  status,
}: {
  warehouseId: string;
  status: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(target: "ACTIVE" | "INACTIVE") {
    if (
      target === "INACTIVE" &&
      !window.confirm("Deactivate this warehouse? Its history stays queryable and it can be reactivated.")
    ) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result =
        target === "ACTIVE"
          ? await activateWarehouseAction(warehouseId)
          : await deactivateWarehouseAction(warehouseId);
      if (!result.success) {
        setError(result.error);
        setBusy(false);
        return;
      }
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        {status !== "ACTIVE" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run("ACTIVE")}
            className={primaryButtonClass}
          >
            Activate warehouse
          </button>
        )}
        {status === "ACTIVE" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run("INACTIVE")}
            className={dangerButtonClass}
          >
            Deactivate warehouse
          </button>
        )}
      </div>
      {error !== null && <ErrorBox message={error} />}
    </div>
  );
}
