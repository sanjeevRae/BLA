import { redirect } from "next/navigation";

/** The root route only routes: /go resolves the session to a dashboard. */
export default function RootPage() {
  redirect("/go");
}
