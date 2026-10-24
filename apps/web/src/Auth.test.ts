import { describe, expect, it } from "vitest";
import { googleError } from "./Auth";

// Server OAuth error codes: services/api/src/auth-api.ts (Google callback flow).
const cases = [
  ["google_cancelled", "Google sign-in was cancelled."],
  ["google_failed", "Google sign-in did not complete. Try again."],
  [
    "google_exists",
    "An account with this email already exists. Sign in with its password, then connect Google under Settings.",
  ],
  ["google_mismatch", "Connect the Google account that uses the same email address as your Concord account."],
  ["google_unverified", "Google has not verified that email address, so it cannot be used to sign in."],
  ["signup_code", "New workspaces need a valid sign-up code from the operator of this server."],
] as const;

describe("googleError()", () => {
  it.each(cases)("returns the dedicated message for %s", (code, expected) => {
    expect(googleError(code)).toBe(expected);
  });

  it("returns undefined for an absent error code", () => {
    expect(googleError(undefined)).toBeUndefined();
  });

  it("falls back to the generic Google failure message for unknown codes", () => {
    expect(googleError("new_unrecognized_error")).toBe(googleError("google_failed"));
  });
});
