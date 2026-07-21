import { describe, expect, it } from "vitest";
import {
  normalizeTag,
  REPO_SLUG,
  releaseTagForVersion,
  VSIX_ASSET,
  vsixDownloadUrl,
} from "./vscode";

describe("releaseTagForVersion", () => {
  it("v-prefixes a plain release version", () => {
    expect(releaseTagForVersion("0.7.0")).toBe("v0.7.0");
  });

  it("strips the +dev build metadata a source checkout carries", () => {
    expect(releaseTagForVersion("0.7.0+dev")).toBe("v0.7.0");
  });

  it("strips a prerelease suffix too", () => {
    expect(releaseTagForVersion("0.7.0-rc.1")).toBe("v0.7.0");
  });
});

describe("normalizeTag", () => {
  it("passes `latest` through", () => {
    expect(normalizeTag("latest")).toBe("latest");
  });

  it("v-prefixes a bare X.Y.Z", () => {
    expect(normalizeTag("0.7.0")).toBe("v0.7.0");
  });

  it("leaves an already v-prefixed tag alone", () => {
    expect(normalizeTag("v0.7.0")).toBe("v0.7.0");
  });
});

describe("vsixDownloadUrl", () => {
  it("uses the /latest/download shortcut for latest", () => {
    expect(vsixDownloadUrl("latest")).toBe(
      `https://github.com/${REPO_SLUG}/releases/latest/download/${VSIX_ASSET}`,
    );
  });

  it("targets the tag's asset otherwise", () => {
    expect(vsixDownloadUrl("v0.7.0")).toBe(
      `https://github.com/${REPO_SLUG}/releases/download/v0.7.0/${VSIX_ASSET}`,
    );
  });
});
