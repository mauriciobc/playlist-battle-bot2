import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isRefusalText,
  looksLikeCreated,
  looksLikeFinale,
  looksLikeTuneRejection,
} from "../test/integration/driver-replies.js";
import { m, setLocale } from "../src/i18n/index.js";

/**
 * How the driver reads the bot's replies - one spec per module, so every
 * predicate in driver-replies.ts is held to the same standard: it fires on
 * the copy it is meant to recognise (taken from the catalog, in both
 * locales) and on nothing else.
 *
 * Each case below is a bug the driver has already shipped once.
 */

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

/**
 * Creation is detected by the bot's announcement, not by the absence of a
 * refusal. The refusal list is a hand-kept heuristic and was missing the
 * English lookup failure ("Could not find account ..."), which made a game
 * that was never created look created. These cases hold the positive matcher
 * to the whole catalog: it must fire on `gameCreated` and on nothing else.
 */
describe("creation detection", () => {
  const REFUSALS_BY_KEY: [keyof ReturnType<typeof m>, unknown[]][] = [
    ["cmdUsage", []],
    ["cmdThemeRequired", []],
    ["cmdLengthRequired", []],
    ["cmdLengthRange", []],
    ["cmdTagChallenger", []],
    ["cmdMaxChallengers", []],
    ["cmdDuplicateChallengers", []],
    ["challengerLookupFailed", ["ghost@nowhere.social"]],
    ["errThemeEmpty", []],
    ["errThemeTooLong", [120]],
    ["errLengthRange", []],
    ["errMinChallenger", []],
    ["errMaxPlayers", []],
    ["errDuplicatePlayer", []],
    ["errPrivateCreate", []],
    ["errCooldown", ["2026-09-22T12:05:00.000Z"]],
    ["errConcurrentGames", [4, 3]],
    ["unexpectedCreateError", []],
    ["noInvitation", []],
    ["errNotInvited", []],
    ["errAlreadyDeclined", []],
    ["errAlreadyAccepted", []],
    ["invitationError", []],
    ["unknownDm", ["playlistbattle"]],
    ["declined", []],
  ];

  for (const locale of ["en", "pt-BR"] as const) {
    describe(`the ${locale} catalog`, () => {
      afterEach(() => setLocale("en"));

      it("reads the creation announcement as the creation", () => {
        setLocale(locale);
        expect(
          looksLikeCreated(m().gameCreated("Theme", 8, 2, "2026-09-22T12:00:00.000Z", "id")),
        ).toBe(true);
      });

      it("never reads a refusal as the creation", () => {
        setLocale(locale);
        const messages = m() as unknown as Record<string, (...a: unknown[]) => string>;
        for (const [key, args] of REFUSALS_BY_KEY) {
          const text = messages[key as string]!(...args);
          expect(looksLikeCreated(text), `${String(key)}: ${text}`).toBe(false);
        }
      });

      it("does not read in-play copy as the creation", () => {
        setLocale(locale);
        const inPlay = [m().duelStart("Theme", 8, 2), m().roundAnnounce(1, 8, "Theme", "@a 0", 0, "@a")];
        for (const text of inPlay) expect(looksLikeCreated(text), text).toBe(false);
      });
    });
  }
});

/**
 * The finale matcher this replaces was one loose regex:
 * /final|encerrad|vencedor|terminou|acabou|🏆|parabéns|parabens/i. Three of
 * its alternatives sit in ordinary in-play posts, so the driver read a
 * running duel as a finished one and never voted:
 *
 *   pt  "Vencedores da rodada levam o pote"       duel start      (vencedor)
 *   pt  "sem vencedor"                            round tie       (vencedor)
 *   en  "🏆 Round 1: @host@mock.social wins!"     round result    (🏆)
 *   en  "Round 8: FINAL TIE — pot of 3 ..."       final-round tie (final)
 *   pt  "Rodada 8: EMPATE NA FINAL — pote ..."    final-round tie (final)
 *
 * Detection therefore anchors on the finale's own phrases.
 */
describe("finale detection — the posts that used to be misread", () => {
  it("does not read the pt-BR duel start as a finale", () => {
    expect(
      looksLikeFinale(
        '⚔️ DUELO INICIADO — "integration test rmuft8nke"\n' +
          "8 rodadas · 2 jogadores\n" +
          "Cada voto = 1 ponto. Vencedores da rodada levam o pote. A Rodada 1 começa abaixo!",
      ),
    ).toBe(false);
  });

  it("does not read a round result as a finale", () => {
    expect(looksLikeFinale("🏆 Round 1: @host@mock.social wins!")).toBe(false);
    expect(looksLikeFinale("🏆 Rodada 1: @host@mock.social venceu!")).toBe(false);
    expect(looksLikeFinale("🤝 Rodada 1: EMPATE — sem vencedor. O pote sobe para 1.")).toBe(false);
    expect(looksLikeFinale("🚶 Rodada 1: W.O. — @a vence sem oposição e leva o pote (+2).")).toBe(false);
  });

  it("does not read a final-round tie as a finale", () => {
    expect(
      looksLikeFinale("🤝 Round 8: FINAL TIE — pot of 3 split 1 point(s) among the tied players."),
    ).toBe(false);
    expect(
      looksLikeFinale(
        "🤝 Rodada 8: EMPATE NA FINAL — pote de 3 dividido em 1 ponto(s) cada entre 2 jogador(es) empatado(s) (sobra descartada).",
      ),
    ).toBe(false);
  });
});

for (const locale of ["en", "pt-BR"] as const) {
  describe(`finale detection against the ${locale} catalog`, () => {
    beforeEach(() => setLocale(locale));
    afterEach(() => setLocale("en"));

    it("is true for the finale thread and every verdict", () => {
      const endsTheDuel = [
        m().champion("@host@mock.social"),
        m().sharedChampionship("@a@mock.social & @b@mock.social"),
        // postFinale builds its root from these; the root always carries the
        // champion line and the final standings.
        [m().champion("@a"), m().finaleTheme("Theme", 8), m().finaleStandings("@a 10 · @b 7")].join("\n"),
        m().sideExpired("Theme"),
        m().sideFizzled("Theme"),
        m().sideForfeit("Theme"),
        m().sideCancelled("Theme"),
        m().sideDefaultWin("Theme", "@a"),
      ];
      for (const text of endsTheDuel) expect(looksLikeFinale(text), text).toBe(true);
    });

    it("is false for every in-play post", () => {
      const inPlay = [
        m().gameCreated("Theme", 8, 2, "2026-09-22T12:00:00.000Z", "game-id"),
        m().inviteDm("Theme", "host", 8, "2026-09-22T12:00:00.000Z"),
        m().submitFirst(8),
        m().tuneAcceptedMore(1, 8, "A Song", 2),
        m().tuneAcceptedComplete(8, 8, "A Song"),
        m().tuneReplaced(2, 8, "A Song"),
        m().replaceTuneDm(2, 1, "A Song", "2026-09-22T12:00:00.000Z"),
        m().duelStart("Theme", 8, 2),
        m().roundAnnounce(1, 8, "Theme", "@a 0 · @b 0", 0, "@a, @b"),
        m().tuneLine("a", "A Song"),
        m().pollPrompt(1),
        m().resolutionWin(1, "a", 2),
        m().resolutionTie(1, 1),
        m().resolutionFinalTie(8, 3, 1),
        m().resolutionWalkover(1, "a", 2),
        m().standingsLine("@a 2 · @b 1"),
        m().potLine(1),
        // The finale is detected by its root; its per-tune replies carry
        // "winner" / "Vencedor" and must not be the trigger.
        m().finaleQueue(),
        m().finaleWinningTune(1, "a", "A Song"),
      ];
      for (const text of inPlay) expect(looksLikeFinale(text), text).toBe(false);
    });
  });
}

/**
 * A tune the bot did not accept. The counter matched only the "not playable"
 * copy, so a tune dropped because its video 404s was reported as submitted -
 * four dead links in one run printed "0 rejected". A full playlist is the one
 * outcome that must NOT count: the driver submits a pool bigger than the
 * playlist, so the extra links are always refused.
 */
describe("tune rejection detection", () => {
  for (const locale of ["en", "pt-BR"] as const) {
    describe(`the ${locale} catalog`, () => {
      afterEach(() => setLocale("en"));

      it("reads every rejection the bot can send for a submitted link", () => {
        setLocale(locale);
        const rejections = [
          m().notPlayable("https://youtu.be/dead"),
          m().resolveVideoError(),
          m().errVideoDup(),
          m().linkRejected(),
        ];
        for (const text of rejections) expect(looksLikeTuneRejection(text), text).toBe(true);
      });

      it("does not count a full playlist or an accepted tune", () => {
        setLocale(locale);
        const accepted = [
          m().errPlaylistFull(8),
          m().tuneAcceptedMore(1, 8, "A Song", 2),
          m().tuneAcceptedComplete(8, 8, "A Song"),
          m().tuneReplaced(2, 8, "A Song"),
          m().submitFirst(8),
        ];
        for (const text of accepted) expect(looksLikeTuneRejection(text), text).toBe(false);
      });
    });
  }
});
