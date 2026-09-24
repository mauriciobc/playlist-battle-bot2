import { describe, it, expect } from "vitest";
import { isRefusalText } from "../test/integration/driver-replies.js";

/**
 * The bare /invite/ alternative matched "Challengers invited" in a success
 * announcement, so the driver reported a refusal while the bot had just
 * created the game. Both real refusals are about a PROBLEM with an
 * invitation, so the matcher anchors on the phrase.
 */
describe("refusal detection", () => {
  it("does not call a successful creation announcement a refusal", () => {
    const announcement =
      '🎮 Duel "integration test rmuft8nke" created!\n' +
      "Length: 8 tunes · Players: 2\n" +
      "Challengers invited";
    expect(isRefusalText(announcement)).toBe(false);
  });

  it("still catches a missing pending invitation", () => {
    expect(
      isRefusalText("No pending invitation found for player@mock.social"),
    ).toBe(true);
  });

  it("still catches a duplicate player", () => {
    expect(isRefusalText("Jogador duplicado: host e challenger são a mesma conta")).toBe(true);
  });

  it("still catches a cooldown", () => {
    expect(isRefusalText("Aguarde o cooldown terminar")).toBe(true);
  });

  it("still catches the playlist-length refusal", () => {
    // "length ... between" matches the /erro|error/ family? No - but the
    // point stands: the bot REFUSED, so the driver must not read this as a
    // created game.
    expect(isRefusalText("Playlist length must be between 8 and 12.")).toBe(true);
  });
});
