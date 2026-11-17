/**
 * Shared brand mark + wordmark (DS §2.6).
 *
 * One mark, used identically in the sidebar (ShellFrame) and on the
 * login split panel: a rounded-square in `primary-dark` containing
 * the letter "B" in semibold white, followed by the wordmark
 * "BLA" (semibold) + "Logistics" (regular).
 *
 * The component renders a fragment (no wrapper element) so callers
 * control layout — ShellFrame's <Link> is already a flex row, and
 * the login panel wraps it in its own flex row. This keeps the
 * sidebar's rendered output identical to the pre-extraction markup.
 *
 * Variants:
 * - `tone="dark"` (default): for dark surfaces (sidebar #172F2B,
 *   login left panel) — wordmark in white / sidebar-text.
 * - `tone="light"`: for light surfaces — wordmark in ink / ink-2.
 * - `markSize`: 32 (sidebar, default) or 40 (login, DS §2.6 slot).
 * - `showWordmark`: false renders the mark alone (collapsed rail).
 */
export interface BrandMarkProps {
  markSize?: 32 | 40;
  showWordmark?: boolean;
  tone?: "dark" | "light";
}

export function BrandMark({
  markSize = 32,
  showWordmark = true,
  tone = "dark",
}: BrandMarkProps) {
  const isLarge = markSize === 40;

  const markClassName = isLarge
    ? "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-dark text-[19px] font-semibold text-white"
    : "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-dark text-[15px] font-semibold text-white";

  const wordmarkClassName = isLarge
    ? "truncate text-[17px] leading-tight"
    : "truncate text-[17px] leading-tight";

  const blaClassName =
    tone === "dark" ? "font-semibold text-white" : "font-semibold text-ink";
  const logisticsClassName =
    tone === "dark"
      ? "font-normal text-sidebar-text"
      : "font-normal text-ink-2";

  return (
    <>
      <span className={markClassName}>B</span>
      {showWordmark ? (
        <span className={wordmarkClassName}>
          <span className={blaClassName}>BLA</span>{" "}
          <span className={logisticsClassName}>Logistics</span>
        </span>
      ) : null}
    </>
  );
}
