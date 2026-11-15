import { logoutAction } from "@/server/actions/session";

/** Sign-out is a form POST to a Server Action (CSRF-protected by the framework). */
export function SignOutButton() {
  return (
    <form action={logoutAction}>
      <button
        type="submit"
        className="rounded-md border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink"
      >
        Sign out
      </button>
    </form>
  );
}
