import { describe, test, expect } from "bun:test";
import { connectionView, OFFLINE_BANNER } from "../src/gateway/console/topbar-state.js";

describe("console top-bar connection state (#256)", () => {
  test("connected → live indicator, no offline banner", () => {
    expect(connectionView(true)).toEqual({ label: "live", tone: "ok", banner: null });
  });

  test("disconnected → offline indicator + reconnect banner", () => {
    const v = connectionView(false);
    expect(v).toEqual({ label: "offline", tone: "err", banner: OFFLINE_BANNER });
    expect(v.banner).toContain("offline");
    expect(v.banner).toContain("reconnecting");
  });
});
