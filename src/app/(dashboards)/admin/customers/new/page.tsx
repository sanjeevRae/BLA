import Link from "next/link";

import { SectionCard } from "@/components/warehouses/ui";
import { CustomerForm } from "@/components/customers/forms";

export default function Page() {
  return (
    <div className="grid gap-5">
      <div>
        <Link href="/admin/customers" className="text-[12px] font-semibold text-brand">
          ← All customers
        </Link>
        <h1 className="mt-1 text-[20px] font-bold text-ink">New customer</h1>
      </div>
      <SectionCard title="Customer record">
        <CustomerForm basePath="/admin" />
      </SectionCard>
    </div>
  );
}
