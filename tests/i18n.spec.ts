import { describe, it, expect, beforeEach } from "vitest";
import { setLocale, m, type Locale } from "../src/i18n/index.js";
import { loadConfig } from "../src/config.js";

const baseEnv = {
  MASTODON_URL: "https://mastodon.example",
  MASTODON_TOKEN: "token",
  BOT_ACCT: "bot",
};

describe("i18n", () => {
  beforeEach(() => {
    setLocale("en");
  });

  it("defaults to en", () => {
    expect(m().statusNone()).toContain("No active games");
  });

  it("switches to pt-BR and back", () => {
    setLocale("pt-BR");
    expect(m().statusNone()).toContain("Nenhum jogo ativo");
    setLocale("en");
    expect(m().statusNone()).toContain("No active games");
  });

  it("has matching keys in both catalogs", () => {
    const locales: Locale[] = ["en", "pt-BR"];
    const keySets = locales.map((loc) => {
      setLocale(loc);
      return Object.keys(m()).sort();
    });
    expect(keySets[0]).toEqual(keySets[1]);
  });

  it("translates command usage errors", () => {
    setLocale("en");
    expect(m().cmdUsage()).toContain("Usage:");
    setLocale("pt-BR");
    expect(m().cmdUsage()).toContain("Uso:");
  });

  it("translates game creation summary", () => {
    setLocale("pt-BR");
    const s = m().gameCreated("tema", 8, 2, "2026-01-01T00:00:00.000Z", "abc");
    expect(s).toContain('Duelo "tema" criado');
    expect(s).toContain("faixas");
    expect(s).toContain("ID do jogo: abc");
  });

  it("translates engine validation errors", () => {
    setLocale("pt-BR");
    expect(m().errThemeEmpty()).toContain("tema");
    expect(m().errLengthRange()).toContain("8 e 12");
    expect(m().errConcurrentGames(3, 3)).toContain("jogos ativos");
  });

  it("translates posts side effects", () => {
    setLocale("pt-BR");
    expect(m().sideExpired("x")).toContain("expirou");
    expect(m().sideFizzled("x")).toContain("esvaziou");
    expect(m().sideForfeit("x")).toContain("encerrado");
    expect(m().sideCancelled("x")).toContain("cancelado");
  });

  it("keeps parameterized numbers/ids", () => {
    setLocale("pt-BR");
    expect(m().errPlaylistFull(12)).toContain("12");
    expect(m().tuneAcceptedComplete(2, 8, "Song")).toContain("2/8");
    expect(m().finalePotSplit(6, 3, 2)).toContain("6");
  });

  it("translates status board values", () => {
    setLocale("en");
    expect(m().gameStatus("INVITED", 0, 8)).toBe("INVITED");
    expect(m().gameStatus("ROUND", 2, 8)).toBe("ROUND 2/8");
    expect(m().statusPoints(5)).toBe("5p");
    setLocale("pt-BR");
    expect(m().gameStatus("INVITED", 0, 8)).toBe("CONVIDADO");
    expect(m().gameStatus("COLLECTING", 0, 8)).toBe("COLETANDO");
    expect(m().gameStatus("ROUND", 2, 8)).toBe("RODADA 2/8");
    expect(m().gameStatus("FINALE", 0, 8)).toBe("FINAL");
    expect(m().statusPoints(5)).toBe("5 pts");
    expect(m().gameStatus("UNKNOWN", 0, 8)).toBe("UNKNOWN");
  });
});

describe("config LOCALE", () => {
  it("defaults to en", () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.locale).toBe("en");
  });

  it("accepts pt-BR", () => {
    const cfg = loadConfig({ ...baseEnv, LOCALE: "pt-BR" });
    expect(cfg.locale).toBe("pt-BR");
  });

  it("rejects unknown locale", () => {
    expect(() => loadConfig({ ...baseEnv, LOCALE: "fr" })).toThrow(/LOCALE/);
  });
});
