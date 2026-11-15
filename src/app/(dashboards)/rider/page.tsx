import Link from "next/link";

import { requireActor } from "@/lib/auth/permissions";
import { RiderHomePage } from "@/components/deliveries/pages";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";

export default async function Page() {
  const actor = await requireActor();
  return (
    <div className="grid gap-5">
      <RiderHomePage actor={actor} />
      <SectionCard title="Cash on delivery">
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-slate2">
            See the COD you have collected, hand it over as a remittance, and track verification.
          </p>
          <div>
            <Link href="/rider/cod" className={subtleButtonClass}>
              Your COD obligations →
            </Link>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
