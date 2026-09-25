/**
 * How the driver reads the bot's replies.
 *
 * Split out of driver.ts so the predicates can be unit-tested without
 * importing the driver, whose module side effects boot a live run against
 * test/integration/.env.
 *
 * Every predicate here is matched against the bot's own i18n strings, in
 * whichever locale it is running:
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

/**
 * The bot's creation announcement - i18n `gameCreated`.
 *
 * The create step used to accept ANY reply that was not in REFUSALS. That
 * makes success depend on the refusal list being exhaustive, and it is not:
 * in English "Could not find account "x" - check the @user@instance format."
 * (challengerLookupFailed) matches no refusal pattern, so a game that was
 * never created looked created - the same failure the list was introduced to
 * fix. Matching the success copy instead cannot pass on an unknown failure:
 * no positive match means no game, whatever the bot said.
 *
 * The word forms are strict on purpose: the failure copy is "Unexpected
 * error creating game." / "Erro inesperado ao criar o jogo.".
 */
export function looksLikeCreated(text: string): boolean {
  return /created|criado/i.test(text);
}

/**
 * A submitted tune the bot did not accept - i18n `notPlayable`,
 * `resolveVideoError`, `errVideoDup`, `linkRejected`.
 *
 * The submit step's counter matched only "notPlayable" copy, so a tune
 * dropped because its video 404s ("Could not resolve that video.") was
 * reported as submitted: a run where four links never landed printed
 * "0 rejected". `errPlaylistFull` is deliberately excluded - the driver
 * submits a pool larger than the playlist, so a full playlist is the
 * expected outcome, not a rejection to report.
 */
const TUNE_REJECTIONS = [
  /not a playable|n[aã]o reproduz/i,
  /could not resolve|n[aã]o foi poss[íi]vel resolver/i,
  /already in your playlist|j[áa] est[áa] na sua playlist/i,
  /link was rejected|link foi rejeitado/i,
];

export function looksLikeTuneRejection(text: string): boolean {
  return TUNE_REJECTIONS.some((re) => re.test(text));
}

/**
 * Statuses that end the duel: the finale thread (champion, shared
 * championship, final standings) or a verdict that closes the game early
 * (expired, fizzled, forfeit, cancelled, default win).
 *
 * Every alternative has to be a phrase only those posts use. The single
 * loose regex this replaces matched "🏆" and "vencedor", which are in round
 * results and in the pt duel-start line ("Vencedores da rodada levam o
 * pote") - so the driver read round 1's kickoff as a finale and reported
 * "0 voted rounds" without ever voting. Bare /final/ also matched the
 * final-round TIE result ("FINAL TIE" / "EMPATE NA FINAL").
 *
 * It also matches the host's cancelDone DM ("cancelled - no champion, no
 * pot"). That is harmless: both call sites classify public statuses only,
 * and the public verdict `sideCancelled` is what ends the run.
 */
const FINALES = [
  // posts.ts finale thread: `champion`, `sharedChampionship`, `finaleStandings`
  /champion|campe[aã]o|campeonato/i,
  /final standings|placar final/i,
  // posts.ts postSideEffect: the verdicts that end a game without a champion
  /expired|expirou/i,
  /fizzled|esvaziou/i,
  /closed|encerrado/i,
  /cancelled by host|cancelado pelo anfitri/i,
  /wins by default|vence por padrão/i,
];

export function looksLikeFinale(text: string): boolean {
  return FINALES.some((re) => re.test(text));
}

/**
 * Whether a bot status belongs to the game this run created.
 *
 * The bot drains a backlog of old newgame commands on boot and announces
 * those games too; every status it emits about a game repeats the theme, so
 * the theme scopes observations to this run. A poll is always kept, though:
 * polls and round results are what later steps wait for, and a poll need not
 * repeat the theme. No theme yet (before create) keeps everything.
 */
export function inRunGame(
  status: { content: string; poll?: unknown },
  gameTheme: string | null,
): boolean {
  return !gameTheme || Boolean(status.poll) || status.content.includes(gameTheme);
}

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
