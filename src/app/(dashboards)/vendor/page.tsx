import { requireActor } from "@/lib/auth/permissions";
import { getVendorHome } from "@/server/services/home-dashboards";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/states";
import { VendorHomeView } from "@/components/vendor-home/VendorHomeView";

/**
 * Vendor home (V3 Step 7): a thin wrapper over the Step 7 read
 * model (`getVendorHome`) and the presentational VendorHomeView.
 * The unlinked case (!actor.vendorId) is handled here, before the
 * model is called — the model assumes the link exists and throws
 * otherwise. Every figure the view renders is org-scoped inside
 * the model's services; nothing is computed from another vendor's
 * data.
 */
export default async function Page() {
  const actor = await requireActor();
  if (!actor.vendorId) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Vendor" title="Vendor dashboard" />
        <EmptyState
          title="Your account is not linked to a vendor organisation yet"
          description="Ask an administrator to invite you into your vendor — bookings and packages appear here once you are linked."
        />
      </div>
    );
  }

  const data = await getVendorHome(actor);
  return <VendorHomeView data={data} vendorRole={actor.vendorRole} />;
}
