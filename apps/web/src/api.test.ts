import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api successful response parsing", () => {
  it("surfaces a useful ApiError rather than raw SyntaxError for HTML 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>Login required</html>", { status: 200, headers: { "content-type": "text/html" } }),
        ),
    );
    await expect(api("/account")).rejects.toMatchObject({
      name: "Error",
      status: 200,
      message: "The server sent an unexpected response.",
    });
  });

  it("permits empty successful 204 responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(api<void>("/session", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("continues to parse normal JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ready: true })));
    await expect(api<{ ready: boolean }>("/ready")).resolves.toEqual({ ready: true });
  });

  it("does not change failed HTTP status handling", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Access forbidden" }, { status: 403 })));
    await expect(api("/protected")).rejects.toEqual(new ApiError("Access forbidden", 403));
  });
});
