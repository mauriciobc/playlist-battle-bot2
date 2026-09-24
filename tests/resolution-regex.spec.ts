import { describe, it, expect } from "vitest";

/**
 * The vote step's "did the round resolve before we voted?" check.
 *
 * An earlier regex matched on the bare word "rodada", which also appears in
 * the game's opening announcement ("⚔️ DUELO INICIADO ... 8 rodadas"). The
 * step then reported success on a game that had just started, the driver
 * never cast a vote, and all eight rounds came back auto_tied.
 *
 * The strings below are transcribed from src/i18n/index.ts. If the bot's copy
 * changes, this test is what should fail first.
 */
const RESOLVED = /rodada\s*\d+\s*:\s*(W\.O\.|empate|@)/i;

describe("round resolution detection", () => {
  const resolutions = [
    "🚶 Rodada 1: W.O. — @mauriciobc vence sem oposição e leva o pote (+1).",
    "🤝 Rodada 2: EMPATE — sem vencedor. O pote sobe para 2.",
    "🏆 Rodada 3: @saiugol venceu! + bônus do pote 2",
    "🤝 Rodada 8: EMPATE NA FINAL — pote de 8 dividido em 1 point(s) para cada jogador empatado.",
  ];

  for (const s of resolutions) {
    it(`counts as resolved: ${s.slice(0, 42)}`, () => {
      expect(RESOLVED.test(s)).toBe(true);
    });
  }

  const notResolutions = [
    '⚔️ DUELO INICIADO — "integration test r1" 8 rodadas · 2 jogadores',
    "🗳️ Vote na melhor faixa da Rodada 1! Qualquer pessoa pode votar.",
    "🎵 Faixa 3/8: Queen – Bohemian Rhapsody",
    "Jogo \"integration test r1\" esvaziou — nenhuma playlist completa",
  ];

  for (const s of notResolutions) {
    it(`is not a resolution: ${s.slice(0, 42)}`, () => {
      expect(RESOLVED.test(s)).toBe(false);
    });
  }
});
