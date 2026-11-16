import { requireActor } from "@/lib/auth/permissions";
import { SupportHomePage } from "@/components/support/pages";

export default async function Page() {
  const actor = await requireActor();
  return <SupportHomePage actor={actor} />;
}
