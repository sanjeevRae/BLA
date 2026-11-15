import { requireActor } from "@/lib/auth/permissions";
import { ArrivalsPage } from "@/components/transfers/pages";

export default async function Page() {
  const actor = await requireActor();
  return <ArrivalsPage actor={actor} basePath="/staff" />;
}
