import { requireActor } from "@/lib/auth/permissions";
import { VendorDetailPage } from "@/components/vendors/pages";

export default async function Page() {
  const actor = await requireActor();
  if (!actor.vendorId) {
    return (
      <div className="rounded-lg border border-line bg-surface p-5 text-[13px] text-ink">
        Your account is not linked to a vendor organisation yet. Ask an administrator to invite
        you into your vendor.
      </div>
    );
  }
  return <VendorDetailPage actor={actor} basePath="/vendor" vendorId={actor.vendorId} />;
}
