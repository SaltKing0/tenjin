import { describe, test, expect } from "bun:test";
import { connectionView, OFFLINE_BANNER } from "../src/gateway/console/topbar-state.js";

describe("console top-bar connection state (#256/#280)", () => {
  test("online → live indicator, no offline banner", () => {
    expect(connectionView("online")).toEqual({ label: "live", tone: "ok", banner: null });
  });

  test("offline → offline indicator + reconnect banner", () => {
    const v = connectionView("offline");
    expect(v).toEqual({ label: "offline", tone: "err", banner: OFFLINE_BANNER });
    expect(v.banner).toContain("offline");
    expect(v.banner).toContain("reconnecting");
  });

  test("connecting → neutral indicator, NO banner (no offline flash on a healthy server)", () => {
    const v = connectionView("connecting");
    expect(v.label).toBeTruthy();
    expect(v.banner).toBeNull();
    expect(v.tone).not.toBe("err");
  });

  test("unknown state falls back to the safe connecting view (no banner)", () => {
    const v = connectionView("bogus");
    expect(v.banner).toBeNull();
  });
});
