import { describe, expect, it } from "vitest";
import { headlessReason, isCi, isHeadless, isSsh } from "./environment";

describe("isCi", () => {
  it("is true for the conventional truthy CI values", () => {
    expect(isCi({ CI: "true" })).toBe(true);
    expect(isCi({ CI: "1" })).toBe(true);
    expect(isCi({ CI: "yes" })).toBe(true);
  });

  it("is false when unset or explicitly falsy", () => {
    expect(isCi({})).toBe(false);
    expect(isCi({ CI: "" })).toBe(false);
    expect(isCi({ CI: "0" })).toBe(false);
    expect(isCi({ CI: "false" })).toBe(false);
    expect(isCi({ CI: "False" })).toBe(false);
  });
});

describe("isSsh", () => {
  it("detects each of sshd's markers independently", () => {
    expect(isSsh({ SSH_CONNECTION: "10.0.0.5 50000 10.0.0.9 22" })).toBe(true);
    expect(isSsh({ SSH_TTY: "/dev/pts/3" })).toBe(true);
    expect(isSsh({ SSH_CLIENT: "10.0.0.5 50000 22" })).toBe(true);
  });

  it("is false with no markers, and treats empty values as unset", () => {
    expect(isSsh({})).toBe(false);
    expect(isSsh({ SSH_CONNECTION: "", SSH_TTY: "", SSH_CLIENT: "" })).toBe(false);
  });
});

describe("headlessReason / isHeadless", () => {
  it("treats CI as headless on any platform", () => {
    expect(headlessReason({ CI: "true" }, "darwin")).toMatch(/CI/);
    expect(isHeadless({ CI: "1" }, "linux")).toBe(true);
    expect(isHeadless({ CI: "true" }, "win32")).toBe(true);
  });

  it("treats SSH as headless, even on macOS", () => {
    expect(headlessReason({ SSH_TTY: "/dev/pts/0" }, "darwin")).toMatch(/SSH/);
    expect(isHeadless({ SSH_CLIENT: "10.0.0.5 50000 22" }, "darwin")).toBe(true);
  });

  it("does not honor X11 forwarding as an exception to SSH", () => {
    // ssh -X sets DISPLAY, but a browser over a forwarded X connection is
    // almost never what the user wants — SSH wins.
    expect(
      headlessReason(
        { SSH_CONNECTION: "10.0.0.5 50000 10.0.0.9 22", DISPLAY: "localhost:10.0" },
        "linux",
      ),
    ).toMatch(/SSH/);
  });

  it("needs DISPLAY or WAYLAND_DISPLAY on Linux", () => {
    expect(headlessReason({}, "linux")).toMatch(/DISPLAY/);
    expect(isHeadless({ DISPLAY: "" }, "linux")).toBe(true);
    expect(isHeadless({ DISPLAY: ":0" }, "linux")).toBe(false);
    expect(isHeadless({ WAYLAND_DISPLAY: "wayland-1" }, "linux")).toBe(false);
  });

  it("assumes a GUI on macOS and Windows outside SSH/CI", () => {
    expect(headlessReason({}, "darwin")).toBeUndefined();
    expect(isHeadless({}, "darwin")).toBe(false);
    expect(isHeadless({}, "win32")).toBe(false);
  });
});
