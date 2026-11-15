import { requireActor } from "@/lib/auth/permissions";
import { TransferCreatePage } from "@/components/transfers/pages";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ origin?: string }>;
}) {
  const actor = await requireActor();
  const params = await searchParams;
  return (
    <TransferCreatePage actor={actor} basePath="/staff" originId={params.origin} />
  );
}
