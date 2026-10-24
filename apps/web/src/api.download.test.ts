import { afterEach, describe, expect, it, vi } from "vitest";
import { download } from "./api";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("download() blob URL lifetime", () => {
  it("clicks an attached anchor, removes it, then revokes only after the grace period", async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn().mockReturnValue("blob:concord-export");
    const revokeObjectURL = vi.fn();
    const NativeURL = URL;
    class DownloadURL extends NativeURL {}
    DownloadURL.createObjectURL = createObjectURL;
    DownloadURL.revokeObjectURL = revokeObjectURL;
    vi.stubGlobal("URL", DownloadURL);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("id,amount\n1,10", {
          status: 200,
          headers: { "content-disposition": 'attachment; filename="reconciliation.csv"' },
        }),
      ),
    );

    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(document.body.contains(this)).toBe(true);
      expect(this.href).toBe("blob:concord-export");
      expect(this.download).toBe("reconciliation.csv");
      expect(revokeObjectURL).not.toHaveBeenCalled();
    });

    await download("/exports/reconcile", "fallback.csv");

    expect(click).toHaveBeenCalledOnce();
    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor).toBeDefined();
    expect(document.body.contains(anchor)).toBe(false);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.advanceTimersByTime(9_999);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:concord-export");
  });

  it("does not allocate a blob URL when the HTTP response fails", async () => {
    const original = URL;
    class DownloadURL extends original {}
    DownloadURL.createObjectURL = vi.fn();
    vi.stubGlobal("URL", DownloadURL);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Not ready" }, { status: 409 })));
    await expect(download("/exports/reconcile", "fallback.csv")).rejects.toMatchObject({
      status: 409,
      message: "Not ready",
    });
    expect(DownloadURL.createObjectURL).not.toHaveBeenCalled();
  });
});
