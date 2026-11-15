import { requireActor } from "@/lib/auth/permissions";
import { RemittancesListPage } from "@/components/finance/pages";

export default async function Page() {
  const actor = await requireActor();
  return <RemittancesListPage actor={actor} basePath="/finance" detailBase="/finance/remittances" />;
}
