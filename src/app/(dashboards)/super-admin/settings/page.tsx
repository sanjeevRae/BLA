import { requireActor } from "@/lib/auth/permissions";
import { SettingsPage } from "@/components/admin-identity/pages";

export default async function Page() {
  const actor = await requireActor();
  return <SettingsPage actor={actor} />;
}
