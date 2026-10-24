import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Units } from "./ui";

function renderedUnits(value: string | null, signed = false) {
  const { container } = render(<Units value={value} signed={signed} />);
  const node = container.firstElementChild as HTMLElement;
  return node;
}

describe("Units amount rendering", () => {
  it("groups integer digits and dims a preserved fractional tail", () => {
    const node = renderedUnits("1234567.8900000");
    expect(node.textContent).toBe("1,234,567.8900000");
    expect(node).not.toHaveClass("text-bad");
    expect(node.querySelector(".opacity-60")?.textContent).toBe(".8900000");
  });

  it("renders unsigned zero without a negative tone", () => {
    const node = renderedUnits("0");
    expect(node.textContent).toBe("0");
    expect(node).not.toHaveClass("text-bad");
  });

  it("keeps small fractions intact", () => {
    const node = renderedUnits("0.5");
    expect(node.textContent).toBe("0.5");
    expect(node).not.toHaveClass("text-bad");
    expect(node.querySelector(".opacity-60")?.textContent).toBe(".5");
  });

  it("shows a negative amount with bad tone when signed", () => {
    const node = renderedUnits("-1000", true);
    expect(node.textContent).toBe("-1,000");
    expect(node).toHaveClass("text-bad");
  });

  it("shows a positive signed amount with the existing bad tone", () => {
    const node = renderedUnits("5", true);
    expect(node.textContent).toBe("+5");
    expect(node).toHaveClass("text-bad");
  });

  it("does not sign or tone zero even when signed", () => {
    const node = renderedUnits("0", true);
    expect(node.textContent).toBe("0");
    expect(node).not.toHaveClass("text-bad");
  });

  it("renders null as an accessible muted placeholder", () => {
    const node = renderedUnits(null);
    expect(node.textContent).toBe("n/a");
    expect(node).toHaveClass("text-muted");
    expect(node).not.toHaveClass("text-bad");
  });

  it("groups 30-digit amounts without numeric precision loss", () => {
    const node = renderedUnits("123456789012345678901234567890");
    expect(node.textContent).toBe("123,456,789,012,345,678,901,234,567,890");
    expect(node).not.toHaveClass("text-bad");
  });
});
