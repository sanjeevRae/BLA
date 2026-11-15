import { requireActor } from "@/lib/auth/permissions";
import { BookingDetailPage } from "@/components/bookings/pages";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  return (
    <BookingDetailPage
      actor={actor}
      basePath="/vendor"
      orderId={id}
      publicBaseUrl={process.env.AUTH_URL ?? ""}
    />
  );
}
