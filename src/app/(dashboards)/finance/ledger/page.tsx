import { requireActor } from "@/lib/auth/permissions";
import { LedgerPage } from "@/components/finance/pages";

export default async function Page() {
  const actor = await requireActor();
  return <LedgerPage actor={actor} />;
}
