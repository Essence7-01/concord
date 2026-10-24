import { describe, expect, it } from "vitest";
import { short, when } from "./ui";

describe("when() UTC table formatting", () => {
  it("returns never for missing timestamps", () => {
    expect(when(null)).toBe("never");
    expect(when(undefined)).toBe("never");
    expect(when("")).toBe("never");
  });

  it("formats UTC ISO timestamps to second precision", () => {
    expect(when("2026-10-06T21:00:00.000Z")).toBe("2026-10-06 21:00:00 UTC");
  });

  it("pins the current date-only double-space behavior", () => {
    // Pin existing behavior rather than silently changing the formatter.
    expect(when("2026-10-06")).toBe("2026-10-06  UTC");
  });

  it("documents that offset timestamps are not normalized", () => {
    // The current formatter labels the source-time as UTC without conversion.
    expect(when("2026-10-06T21:00:00+02:00")).toBe("2026-10-06 21:00:00 UTC");
  });

  it("does not depend on the viewer's timezone", () => {
    expect(when("2026-10-06T00:00:01.000Z")).toBe("2026-10-06 00:00:01 UTC");
  });
});

describe("short() address and hash truncation", () => {
  it("shortens a 56-character G address preserving both ends", () => {
    expect(short(`GABCD${"Z".repeat(46)}VWXYZ`)).toBe("GABCD…VWXYZ");
  });

  it("leaves exactly 14 characters unchanged", () => {
    expect(short("ABCDEFGHIJKLMN")).toBe("ABCDEFGHIJKLMN");
  });

  it("shortens 15 characters at the boundary", () => {
    expect(short("ABCDEFGHIJKLMNO")).toBe("ABCDE…KLMNO");
  });

  it("preserves an empty string", () => {
    expect(short("")).toBe("");
  });

  it("truncates multibyte Unicode characters without converting to ASCII", () => {
    expect(short("αβγδεζηθικλμνξο")).toBe("αβγδε…λμνξο");
  });
});
