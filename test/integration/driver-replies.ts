/**
 * How the driver reads the bot's replies.
 *
 * Split out of driver.ts so the predicates can be unit-tested without
 * importing the driver, whose module side effects boot a live run against
 * test/integration/.env.
 *
 * Both sets are matched against the bot's own i18n strings, in whichever
 * locale it is running:
 *   en  "You're in! 🎵" / "You're invited to duel ..."
 *   pt  "Você está dentro! 🎵" / "Você foi convidado para o duelo ..."
 */

/**
 * Replies that mean the bot refused the command.
 *
 * "bot replied in the thread" is not success on the own: the bot always
 * answers, including with a refusal. Treating any reply as success let a
 * game that was never created look like it had been.
 */
const REFUSALS = [
  /n[aã]o encontrada|not found/i,
  /jogador duplicado|duplicate player/i,
  /cooldown/i,
  /n[aã]o entendi/i,
  /erro|error/i,
  // The bot answers, but no game exists: the length was outside 8..12.
  // Missing this made a rejected game indistinguishable from a created one.
  /playlist length must be between/i,
  // "invited" appears in a SUCCESS announcement ("Challengers invited"), so
  // a bare /invite/ substring test refuses a game the bot just created. Both
  // real refusals are about a problem with an invitation:
  //   "No pending invitation found for ..."
  //   "convite pendente"
  /no pending invitation|invitation not found|convite.*pendente/i,
];

export function isRefusalText(text: string): boolean {
  return REFUSALS.some((re) => re.test(text));
}

export const isRefusal = isRefusalText;

/**
 * The bot's acceptance of a duel invitation - i18n `youAreIn`.
 *
 * The invitation guard is checked FIRST and returns false outright. Stacking
 * it as an independent "not invite" filter beside the acceptance match would
 * reject an acceptance that merely mentions an invitation - and "You're
 * invited to duel" is the message immediately before it, so the guard has to
 * win by priority, not by luck.
 */
export function looksLikeAcceptance(text: string): boolean {
  if (/convidado|convidata|invited|no pending invitation|convite pendente/i.test(text)) {
    return false;
  }
  return /dentro|you.re in|inside|aceit|entrou|desafio aceito|bem-vindo|bem vindo/i.test(
    text,
  );
}
