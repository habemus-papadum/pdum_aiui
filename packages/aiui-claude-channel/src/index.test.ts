import { describe, expect, it } from "vitest";
import { CHANNEL_CONFIG, createChannelServer, name } from "./index";

describe(name, () => {
  it("re-exports the channel factory and config", () => {
    expect(createChannelServer("1.2.3")).toBeTruthy();
    expect(CHANNEL_CONFIG.channel.source).toBe("aiui");
  });
});
