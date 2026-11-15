import { requireActor } from "@/lib/auth/permissions";
import { InvoicesListPage } from "@/components/finance/pages";

export default async function Page() {
  const actor = await requireActor();
  return <InvoicesListPage actor={actor} basePath="/finance" detailBase="/finance/invoices" />;
}
