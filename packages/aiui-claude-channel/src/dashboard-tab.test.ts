import { describe, expect, it } from "vitest";
import { dashboardTabTarget } from "./dashboard-tab";

describe("dashboardTabTarget", () => {
  it("targets a LOCAL loopback session browser with the dashboard on our port", () => {
    expect(
      dashboardTabTarget(
        {
          enabled: true,
          connection: "attach",
          browserUrl: "http://127.0.0.1:54321",
          userDataDir: "/profile",
        },
        62994,
      ),
    ).toEqual({
      browserUrl: "http://127.0.0.1:54321",
      dashboardUrl: "http://127.0.0.1:62994/",
    });
  });

  it("skips a remote `--aiui-browser-url` attach (no userDataDir we manage)", () => {
    expect(
      dashboardTabTarget(
        { enabled: true, connection: "attach", browserUrl: "http://127.0.0.1:9222" },
        62994,
      ),
    ).toBeUndefined();
  });

  it("skips a non-loopback browser (unreachable for our loopback dashboard)", () => {
    expect(
      dashboardTabTarget(
        {
          enabled: true,
          connection: "attach",
          browserUrl: "http://10.0.0.7:9222",
          userDataDir: "/profile",
        },
        62994,
      ),
    ).toBeUndefined();
  });

  it("skips launch-mode (no browserUrl) and the no-chrome cases", () => {
    expect(
      dashboardTabTarget({ enabled: true, connection: "launch", userDataDir: "/p" }, 62994),
    ).toBeUndefined();
    expect(dashboardTabTarget({ enabled: false }, 62994)).toBeUndefined();
    expect(dashboardTabTarget(undefined, 62994)).toBeUndefined();
  });
});
