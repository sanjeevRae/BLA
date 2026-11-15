import Link from "next/link";

import { requireActor } from "@/lib/auth/permissions";
import { FinanceHomePage } from "@/components/finance/pages";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";

export default async function Page() {
  const actor = await requireActor();
  return (
    <div className="grid gap-5">
      <FinanceHomePage actor={actor} />
      <SectionCard title="Reports">
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-slate2">
            Revenue, receivables ageing, settlements, refunds and the full COD reconciliation —
            computed from the live finance records.
          </p>
          <div>
            <Link href="/finance/reports" className={subtleButtonClass}>
              Financial reports →
            </Link>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
