import { requireActor } from "@/lib/auth/permissions";
import { BookingCreatePage } from "@/components/bookings/pages";

export default async function Page() {
  const actor = await requireActor();
  return <BookingCreatePage actor={actor} basePath="/vendor" />;
}
