// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth/permissions", () => ({
  getActorContext: async () => null,
}));

vi.mock("@/components/auth/LoginForm", () => ({
  LoginForm: () => (
    <form aria-label="Sign in form">
      <button type="submit">Sign in</button>
    </form>
  ),
}));

import { cleanup, render, screen } from "@testing-library/react";

afterEach(() => cleanup());

import { BrandMark } from "@/components/layout/BrandMark";
import LoginPage from "@/app/(public)/login/page";

describe("BrandMark — shared mark (DS §2.6)", () => {
  it("renders the 32px sidebar mark with wordmark by default", () => {
    const { container } = render(
      <div className="flex items-center gap-2.5">
        <BrandMark />
      </div>,
    );
    const mark = screen.getByText("B");
    expect(mark.className).toContain("h-8");
    expect(mark.className).toContain("w-8");
    expect(mark.className).toContain("rounded-lg");
    expect(mark.className).toContain("bg-primary-dark");
    expect(mark.className).toContain("font-semibold");
    expect(mark.className).toContain("text-white");
    expect(screen.getByText("BLA").className).toContain("text-white");
    expect(screen.getByText("Logistics").className).toContain("text-sidebar-text");
    expect(container.querySelector(".text-\\[17px\\]")).toBeTruthy();
  });

  it("renders the 40px login mark when markSize is 40", () => {
    render(
      <div className="flex items-center gap-3">
        <BrandMark markSize={40} />
      </div>,
    );
    const mark = screen.getByText("B");
    expect(mark.className).toContain("h-10");
    expect(mark.className).toContain("w-10");
    expect(mark.className).toContain("bg-primary-dark");
    expect(screen.getByText("BLA")).toBeTruthy();
    expect(screen.getByText("Logistics")).toBeTruthy();
  });

  it("omits the wordmark when showWordmark is false (collapsed rail)", () => {
    render(<BrandMark showWordmark={false} />);
    expect(screen.getByText("B")).toBeTruthy();
    expect(screen.queryByText("BLA")).toBeNull();
    expect(screen.queryByText("Logistics")).toBeNull();
  });
});

describe("LoginPage — split treatment (DS §2.6)", () => {
  it("renders the dark left panel and white right panel with the form", async () => {
    const ui = await LoginPage();
    const { container } = render(ui);

    const main = container.querySelector("main");
    expect(main?.className).toContain("flex-col");
    expect(main?.className).toContain("lg:flex-row");

    // Left panel: sidebar colour, brand mark at login size, product line.
    const left = container.querySelector("section.bg-sidebar");
    expect(left).toBeTruthy();
    expect(left?.textContent).toContain("Delivery operations platform");
    expect(left?.textContent).toContain("BLA");
    expect(left?.textContent).toContain("Logistics");
    const loginMark = left?.querySelector(".h-10.w-10");
    expect(loginMark?.textContent).toBe("B");
    expect(loginMark?.className).toContain("bg-primary-dark");

    // Right panel: white, heading + sign-in context copy + form.
    const right = container.querySelector("section.bg-card");
    expect(right).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(
      screen.getByText("Use your organisation account to continue."),
    ).toBeTruthy();
    expect(screen.getByRole("form", { name: "Sign in form" })).toBeTruthy();

    // Footer: ink-2, never faint.
    const footer = screen.getByText(
      /Accounts are created by your administrator/,
    );
    expect(footer.className).toContain("text-ink-2");
    expect(footer.className).not.toContain("text-faint");

    // No legacy tokens remain in the rendered page.
    expect(container.innerHTML).not.toContain("text-faint");
    expect(container.innerHTML).not.toContain("text-slate");
    expect(container.innerHTML).not.toContain("border-line");
  });
});
