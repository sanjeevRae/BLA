import Link from "next/link";

import { SectionCard } from "@/components/warehouses/ui";
import { VendorForm } from "@/components/vendors/forms";

export default function Page() {
  return (
    <div className="grid gap-5">
      <div>
        <Link href="/super-admin/vendors" className="text-[12px] font-semibold text-brand">
          ← All vendors
        </Link>
        <h1 className="mt-1 text-[20px] font-bold text-ink">New vendor</h1>
        <p className="text-[13px] text-faint">
          New vendors start as PENDING VERIFICATION; invite their first user from the vendor page.
        </p>
      </div>
      <SectionCard title="Vendor profile">
        <VendorForm basePath="/super-admin" />
      </SectionCard>
    </div>
  );
}
