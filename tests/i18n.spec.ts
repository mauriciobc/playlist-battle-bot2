import { describe, it, expect, afterEach } from "vitest";
import { setLocale, m } from "../src/i18n/index.js";

// Catalog copy itself is not pinned here; key parity between catalogs is
// enforced by both being typed as `Messages`.
describe("i18n", () => {
  afterEach(() => setLocale("en"));

  it("setLocale swaps the active catalog", () => {
    const en = m();
    setLocale("pt-BR");
    expect(m()).not.toBe(en);
    setLocale("en");
    expect(m()).toBe(en);
  });

  it("formats status-board values per locale, passing unknown statuses through", () => {
    expect(m().gameStatus("INVITED", 0, 8)).toBe("INVITED");
    expect(m().gameStatus("ROUND", 2, 8)).toBe("ROUND 2/8");
    setLocale("pt-BR");
    expect(m().gameStatus("COLLECTING", 0, 8)).toBe("COLETANDO");
    expect(m().gameStatus("ROUND", 2, 8)).toBe("RODADA 2/8");
    expect(m().gameStatus("UNKNOWN", 0, 8)).toBe("UNKNOWN");
  });
});
