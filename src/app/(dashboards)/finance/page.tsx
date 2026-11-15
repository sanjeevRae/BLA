import { requireActor } from "@/lib/auth/permissions";
import { FinanceHomePage } from "@/components/finance/pages";

export default async function Page() {
  const actor = await requireActor();
  return <FinanceHomePage actor={actor} />;
}
