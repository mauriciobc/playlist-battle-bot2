import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { APP_VERSION, GIT_SHA, VERSION_STAMP } from "../src/version.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

describe("version", () => {
  it("exposes the package.json version", () => {
    expect(APP_VERSION).toBe(pkg.version);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("uses GIT_SHA from the environment when set, else 'dev'", () => {
    const env = process.env.GIT_SHA;
    if (env && env.trim()) {
      expect(GIT_SHA).toBe(env.trim());
    } else {
      expect(GIT_SHA).toBe("dev");
    }
  });

  it("builds a readable startup stamp", () => {
    expect(VERSION_STAMP).toBe(`${APP_VERSION} (${GIT_SHA})`);
  });
});
