import { describe, expect, it } from "vitest";
import { trimFractionalZeros } from "./ui";

describe("trimFractionalZeros", () => {
  it("removes only a redundant decimal fraction", () => {
    expect(trimFractionalZeros("1000.0000000")).toBe("1000");
    expect(trimFractionalZeros("0.0000000")).toBe("0");
  });

  it("never removes trailing zeros from an integer", () => {
    expect(trimFractionalZeros("1000")).toBe("1000");
    expect(trimFractionalZeros("500000")).toBe("500000");
  });

  it("keeps non-zero fractional digits intact", () => {
    expect(trimFractionalZeros("0.5000000")).toBe("0.5");
    expect(trimFractionalZeros("12.3400500")).toBe("12.34005");
  });

  it("preserves large integer precision without Number conversion", () => {
    expect(trimFractionalZeros("123456789012345678901234567890")).toBe("123456789012345678901234567890");
  });
});
