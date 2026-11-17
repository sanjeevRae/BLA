import type { ButtonHTMLAttributes } from "react";

/**
 * Shared button (DS §7.3). Variants:
 * - primary: teal bg, white label — ONE per view (page action bar or card).
 * - secondary: white bg, border-control border, ink label.
 * - ghost: transparent, ink-2 label.
 * - danger: Failed text on Failed tint; `danger-solid` (solid Failed +
 *   white) is reserved for the final commit inside confirmation dialogs.
 * Radius 12, 14px/550, 40px height (44px touch target on field surfaces
 * via min-h). Disabled = 45% opacity + aria-disabled semantics from the
 * native `disabled` attribute.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-solid";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-primary text-white hover:bg-primary-dark",
  secondary: "border border-border-control bg-card text-ink hover:bg-surface-2",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
  danger: "bg-dangerbg text-danger hover:bg-dangerbg/70",
  "danger-solid": "bg-danger text-white hover:bg-danger/90",
};

export type ButtonProps = {
  variant?: ButtonVariant;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export function Button({
  variant = "primary",
  type = "button",
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-[14px] font-[550] disabled:opacity-45 ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    />
  );
}
