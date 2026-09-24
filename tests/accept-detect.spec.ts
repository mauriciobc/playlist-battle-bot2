import { describe, it, expect } from "vitest";
import { looksLikeAcceptance } from "../test/integration/driver-replies.js";

/**
 * The bot accepted - the database said COLLECTING, and the DM read
 *
 *   dm-1010  accept
 *   dm-1012  You're in! 🎵
 *   dm-1014  Send tune 1 of 8 - reply with just a YouTube link.
 *
 * - and the driver waited out its 180s backstop anyway.
 *
 * classifyAcceptance matched /dentro|inside|aceit|entrou|.../i, which is the
 * Portuguese "voce esta dentro". The bot's actual reply is the English
 * "You're in!" plus a music note. Nothing in that phrase matched.
 *
 * Worse, the guard that keeps an INVITE from reading as an acceptance
 * (/convidado|convidata|invite/i) would also throw away "You're in" if the
 * bot ever phrased the next step with the word invite - which it does, in
 * "You're invited to duel". So the two patterns have to be judged together,
 * not stacked as independent filters.
 */
describe("acceptance detection", () => {
  it("recognises the bot's actual acceptance reply", () => {
    expect(looksLikeAcceptance("You're in! 🎵")).toBe(true);
  });

  it("recognises the Portuguese phrasing it was written for", () => {
    expect(looksLikeAcceptance("Você está dentro! 🎵")).toBe(true);
  });

  it("never reads an invitation as an acceptance", () => {
    // This is the case the guard exists for: an unaccepted game would
    // otherwise look accepted and the run would skip the whole middle.
    expect(
      looksLikeAcceptance('You\'re invited to duel "integration test r4x"!'),
    ).toBe(false);
  });

  it("never reads the Portuguese invitation as an acceptance", () => {
    expect(looksLikeAcceptance('Você foi convidado para o duelo "teste"!')).toBe(false);
  });

  it("does not read a tune request as an acceptance", () => {
    expect(
      looksLikeAcceptance("Send tune 1 of 8 - reply with just a YouTube link."),
    ).toBe(false);
  });

  it("does not read a refusal as an acceptance", () => {
    expect(looksLikeAcceptance("No pending invitation found for you.")).toBe(false);
  });
});
