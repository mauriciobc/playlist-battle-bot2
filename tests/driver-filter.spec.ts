import { describe, it, expect } from "vitest";
import { inRunGame } from "../test/integration/driver-replies.js";

/**
 * Regression cover for the crash that cost three hours.
 *
 * botActivity() filtered statuses with `s.hasPoll`, but hasPoll is a field
 * the following .map manufactures - it does not exist on the raw
 * MastodonStatus. The filter threw on every poll, which is precisely the one
 * thing the driver exists to observe.
 *
 * test/integration was absent from tsconfig's include list, so `tsc --noEmit`
 * stayed green while the driver was broken. The real fix was adding it to the
 * include; these tests keep the logic honest once it compiles.
 */
describe("botActivity theme filter", () => {
  it("keeps a poll visible even when it does not mention the theme", () => {
    const poll = { id: "p1", options: [] };
    expect(inRunGame({ content: "which round?", poll }, "E2E r1")).toBe(true);
  });

  it("keeps a status that mentions the theme", () => {
    expect(inRunGame({ content: 'Rodada 1 de "E2E r1"' }, "E2E r1")).toBe(true);
  });

  it("drops a status belonging to another game", () => {
    expect(inRunGame({ content: 'Rodada 1 de "someone else"', poll: null }, "E2E r1")).toBe(false);
  });

  it("keeps everything before the game's theme is known", () => {
    expect(inRunGame({ content: 'Rodada 1 de "someone else"' }, null)).toBe(true);
  });
});
