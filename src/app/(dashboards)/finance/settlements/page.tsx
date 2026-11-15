import { requireActor } from "@/lib/auth/permissions";
import { SettlementsListPage } from "@/components/finance/pages";

export default async function Page() {
  const actor = await requireActor();
  return <SettlementsListPage actor={actor} basePath="/finance" detailBase="/finance/settlements" />;
}
