import { requireActor } from "@/lib/auth/permissions";
import { RiderHomePage } from "@/components/deliveries/pages";

export default async function Page() {
  const actor = await requireActor();
  return <RiderHomePage actor={actor} />;
}
