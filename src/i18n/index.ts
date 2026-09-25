/**
 * Locale catalogs for all user-facing bot copy.
 * `setLocale` at boot; call `m()` wherever a reply/post is built.
 */

export type Locale = "en" | "pt-BR";

const en = {
  // commands.ts
  cmdUsage: () =>
    'Usage: @bot newgame "<theme>" <length 8-12> @challenger1 [@challenger2] [@challenger3]',
  cmdThemeRequired: () =>
    'Theme is required. Usage: @bot newgame "<theme>" <length 8-12> @ch1 ...',
  cmdLengthRequired: () => "Playlist length (8-12) is required after the theme.",
  cmdLengthRange: () => "Playlist length must be between 8 and 12.",
  cmdTagChallenger: () => 'Tag at least 1 challenger: @bot newgame "theme" 8 @friend',
  cmdMaxChallengers: () => "Maximum 3 challengers (4 players total, poll limit).",
  cmdDuplicateChallengers: () => "Duplicate challengers in command.",
  challengerLookupFailed: (acct: string) => "Could not find account \"" + acct + "\" — check the @user@instance format.",

  // engine.ts (ValidationError)
  errThemeEmpty: () => "Theme must not be empty.",
  errThemeTooLong: (max: number) => `Theme must be at most ${max} characters.`,
  errLengthRange: () => "Playlist length must be between 8 and 12.",
  errMinChallenger: () => "Need at least 1 challenger (2 players minimum).",
  errMaxPlayers: () => "Maximum 4 players (host + 3 challengers).",
  errDuplicatePlayer: () => "Duplicate player (or challenger equals host).",
  errNotInvited: () => "You are not an invited challenger for this game.",
  errAlreadyDeclined: () => "You already declined this invitation.",
  errAlreadyAccepted: () => "You already accepted; cannot decline now.",
  errNotCollecting: () => "This game is not accepting submissions.",
  errNotAcceptedPlayer: () => "You are not an accepted player in this game.",
  errPlaylistFull: (len: number) => `Playlist is full (${len} tunes).`,
  errVideoDup: () => "That video is already in your playlist.",
  errReplacePosition: (len: number) => `Replace position must be between 1 and ${len}.`,
  errReplaceMissing: (pos: number) => `You have no tune at position ${pos} to replace.`,
  errReplaceWindowOnly: (round: number) =>
    `Only the current round's tune (position ${round}) can be replaced while its replacement window is open.`,
  errReplacementAmbiguous: () =>
    "More than one game has an open replacement window. Reply to the replacement notice for the game you mean.",

  // rateLimit.ts
  errConcurrentGames: (n: number, max: number) => `You already have ${n} active games (max ${max}).`,
  errCooldown: (retryAt: string) => `Game creation cooldown: try again after ${retryAt}.`,

  // handlers: public commands and DMs
  errPrivateCreate: () =>
    "Create duels with a public or unlisted mention; private posts cannot host the public round thread.",
  gameCreated: (theme: string, length: number, players: number, deadline: string, gameId: string) =>
    `🎮 Duel "${theme}" created!\n` +
    `Length: ${length} tunes · Players: ${players}\n` +
    `Challengers invited — accept via DM by ${deadline}.\n` +
    `Game ID: ${gameId}`,
  inviteDm: (theme: string, hostAcct: string, length: number, deadline: string) =>
    `You're invited to duel "${theme}"!\n` +
    `Host: @${hostAcct}\n` +
    `Playlist length: ${length}\n` +
    `Accept deadline: ${deadline}\n` +
    `Reply "accept" or "decline".`,
  unexpectedCreateError: () => "Unexpected error creating game.",
  statusNone: () => 'No active games found. Create one: @bot newgame "theme" 8 @friend',
  statusLabelStatus: () => "Status",
  statusLabelTheme: () => "Theme",
  statusLabelPot: () => "Pot",
  statusLabelPlayers: () => "Players",
  statusLabelGameId: () => "Game ID",
  gameStatus: (status: string, round: number, total: number) => (status === "ROUND" ? `ROUND ${round}/${total}` : status),
  statusPoints: (points: number) => `${points}p`,
  unknownDm: (botAcct: string) =>
    `I didn't understand that. Send "accept"/"decline"/"cancel", or a YouTube link for your tune. To start a game, mention me publicly: @${botAcct} newgame "<theme>" 8-12 @friend`,
  noInvitation: () => "No pending invitation found for you.",
  cancelDone: (theme: string) =>
    `🚫 Game "${theme}" cancelled — no champion, no pot. Scores stay as historical record.`,
  cancelNothing: () =>
    'No open game of yours to cancel. Only the host can cancel, and only while the duel is open (DM "cancel").',
  declined: () => "Declined. Good luck out there.",
  youAreIn: () => "You're in! 🎵",
  submitFirst: (len: number) =>
    `Send tune 1 of ${len} — reply with just a YouTube link. Order = play order.`,
  invitationError: () => "Could not process invitation response.",
  noCollecting: () => "No game is collecting submissions from you right now.",
  notPlayable: (url: string) => `Not a playable YouTube link: ${url}`,
  alreadyInPlaylist: () => "Already in your playlist.",
  tuneAcceptedComplete: (pos: number, len: number, title: string) =>
    `✅ Tune ${pos}/${len}: ${title}\nPlaylist complete!`,
  tuneAcceptedMore: (pos: number, len: number, title: string, next: number) =>
    `✅ Tune ${pos}/${len}: ${title}\nSend tune ${next} of ${len}.`,
  resolveVideoError: () => "Could not resolve that video.",
  linkRejected: () => "That link was rejected.",
  tuneReplaced: (pos: number, len: number, title: string) =>
    `🔁 Replaced tune ${pos}/${len}: ${title}`,
  replaceTuneDm: (pos: number, round: number, title: string, deadline: string) =>
    `⚠️ Tune ${pos} ("${title}") for Round ${round} is no longer playable.\n` +
    `DM a replacement YouTube link before ${deadline}, or reply "replace ${pos} <url>".\n` +
    `No replacement → you forfeit Round ${round} only.`,
  duelStart: (theme: string, rounds: number, players: number) =>
    `⚔️ DUEL START — "${theme}"\n` +
    `${rounds} rounds · ${players} players\n` +
    `Every vote = 1 point. Round winners take the pot. Round 1 begins below!`,

  // posts.ts
  roundAnnounce: (round: number, total: number, theme: string, standings: string, pot: number, playing: string) =>
    `🔔 Round ${round}/${total} — "${theme}"\n` +
    `Vote for the song that best fits the theme: "${theme}"\n` +
    `Standings: ${standings}\n` +
    `Pot: ${pot} · Players this round: ${playing}`,
  tuneLine: (acct: string, title: string) => `🎵 @${acct} — ${title}`,
  pollPrompt: (round: number) =>
    `🗳️ Vote for the best tune in Round ${round}! Anyone can vote.`,
  resolutionWalkover: (round: number, acct: string, pot: number) =>
    `🚶 Round ${round}: walkover — @${acct} wins unopposed and takes the pot (+${pot}).`,
  resolutionTie: (round: number, newPot: number) =>
    `🤝 Round ${round}: TIE — no winner. Pot grows to ${newPot}.`,
  resolutionFinalTie: (round: number, total: number, each: number) =>
    `🤝 Round ${round}: FINAL TIE — pot of ${total} split ${each} point(s) among the tied players.`,
  resolutionWin: (round: number, acct: string, bonus: number) =>
    `🏆 Round ${round}: @${acct} wins!${bonus > 0 ? ` + pot bonus ${bonus}` : ""}`,
  standingsLine: (standings: string) => `Standings: ${standings}`,
  potLine: (pot: number) => `Pot: ${pot}`,
  sharedChampionship: (handles: string) => `🏆 Shared championship: ${handles}!`,
  champion: (handle: string) => `🏆 Champion: ${handle}!`,
  finaleTheme: (theme: string, rounds: number) => `Theme: "${theme}" · ${rounds} rounds`,
  finaleStandings: (standings: string) => `Final standings: ${standings}`,
  finalePotSplit: (total: number, each: number, count: number) =>
    `Final-round tie: pot of ${total} split ${each} point(s) each among ${count} tied player(s) (remainder discarded).`,
  finaleDuelLink: (threadId: string) => `Full duel: reply chain root ${threadId}`,
  finaleQueue: () => "▶️ Whole battle, in order:",
  finaleWinningTune: (round: number, acct: string, title: string) => `🎵 Round ${round} winner @${acct} — ${title}`,
  /** YouTube Music playlist metadata for the battle (saved-playlist path). */
  playlistTitle: (theme: string, rounds: number) => `Playlist Battle — ${theme} (${rounds} rounds)`,
  playlistDescription: (theme: string, rounds: number) =>
    `Round winners of a Playlist Battle on the theme "${theme}" (${rounds} rounds).`,
  sideExpired: (theme: string) =>
    `⌛ Game "${theme}" expired — no challenger accepted the invitation in time.`,
  sideFizzled: (theme: string) =>
    `💨 Game "${theme}" fizzled — no complete playlists were submitted before the deadline.`,
  sideForfeit: (theme: string) =>
    `⚠️ Game "${theme}" closed — a player account was deleted or unreachable. No champion crowned.`,
  sideCancelled: (theme: string) => `🚫 Game "${theme}" cancelled by host.`,
  sideDefaultWin: (theme: string, winnerAcct: string) =>
    `🎖️ Game "${theme}": only one complete playlist — @${winnerAcct} wins by default (last one standing)!`,
};

const PT_BR_STATUS: Record<string, string> = {
  CREATED: "CRIADO",
  INVITED: "CONVIDADO",
  COLLECTING: "COLETANDO",
  READY: "PRONTO",
  FINALE: "FINAL",
  CLOSED: "ENCERRADO",
  EXPIRED: "EXPIRADO",
  FIZZLED: "ESVAZIADO",
  FORFEIT: "DESCLASSIFICADO",
  CANCELLED: "CANCELADO",
};

/** Every locale must implement the English catalog exactly. */
export type Messages = typeof en;

const ptBR: Messages = {
  cmdUsage: () =>
    'Uso: @bot newgame "<tema>" <tamanho 8-12> @desafiante1 [@desafiante2] [@desafiante3]',
  cmdThemeRequired: () =>
    'O tema é obrigatório. Uso: @bot newgame "<tema>" <tamanho 8-12> @d1 ...',
  cmdLengthRequired: () => "O tamanho da playlist (8-12) é obrigatório após o tema.",
  cmdLengthRange: () => "O tamanho da playlist deve ser entre 8 e 12.",
  cmdTagChallenger: () => 'Mencione pelo menos 1 desafiante: @bot newgame "tema" 8 @amigo',
  cmdMaxChallengers: () => "Máximo de 3 desafiadores (4 jogadores no total, limite da enquete).",
  cmdDuplicateChallengers: () => "Desafiadores duplicados no comando.",
  challengerLookupFailed: (acct: string) => "Conta \"" + acct + "\" não encontrada — verifique o formato @usuario@instancia.",

  errThemeEmpty: () => "O tema não pode ficar vazio.",
  errThemeTooLong: (max) => `O tema deve ter no máximo ${max} caracteres.`,
  errLengthRange: () => "O tamanho da playlist deve ser entre 8 e 12.",
  errMinChallenger: () => "É preciso pelo menos 1 desafiante (mínimo de 2 jogadores).",
  errMaxPlayers: () => "Máximo de 4 jogadores (anfitrião + 3 desafiadores).",
  errDuplicatePlayer: () => "Jogador duplicado (ou o desafiante é o anfitrião).",
  errNotInvited: () => "Você não é um desafiante convidado neste duelo.",
  errAlreadyDeclined: () => "Você já recusou este convite.",
  errAlreadyAccepted: () => "Você já aceitou; não pode recusar agora.",
  errNotCollecting: () => "Este duelo não está aceitando submissões.",
  errNotAcceptedPlayer: () => "Você não é um jogador aceito neste duelo.",
  errPlaylistFull: (len) => `Playlist cheia (${len} faixas).`,
  errVideoDup: () => "Esse vídeo já está na sua playlist.",
  errReplacePosition: (len) => `A posição para substituir deve ser entre 1 e ${len}.`,
  errReplaceMissing: (pos) => `Você não tem faixa na posição ${pos} para substituir.`,
  errReplaceWindowOnly: (round) =>
    `Só a faixa da rodada atual (posição ${round}) pode ser substituída enquanto a janela de substituição estiver aberta.`,
  errReplacementAmbiguous: () =>
    "Mais de um jogo tem uma janela de substituição aberta. Responda ao aviso de substituição do jogo desejado.",

  errConcurrentGames: (n, max) => `Você já tem ${n} jogos ativos (máx ${max}).`,
  errCooldown: (retryAt) => `Cooldown de criação de jogo: tente novamente após ${retryAt}.`,

  errPrivateCreate: () =>
    "Crie duelos com uma menção pública ou não listada; posts privados não podem hospedar a thread pública das rodadas.",
  gameCreated: (theme, length, players, deadline, gameId) =>
    `🎮 Duelo "${theme}" criado!\n` +
    `Tamanho: ${length} faixas · Jogadores: ${players}\n` +
    `Desafiadores convidados — aceite por DM até ${deadline}.\n` +
    `ID do jogo: ${gameId}`,
  inviteDm: (theme, hostAcct, length, deadline) =>
    `Você foi convidado para o duelo "${theme}"!\n` +
    `Anfitrião: @${hostAcct}\n` +
    `Tamanho da playlist: ${length}\n` +
    `Prazo para aceitar: ${deadline}\n` +
    `Responda "accept" ou "decline".`,
  unexpectedCreateError: () => "Erro inesperado ao criar o jogo.",
  statusNone: () => 'Nenhum jogo ativo encontrado. Crie um: @bot newgame "tema" 8 @amigo',
  statusLabelStatus: () => "Status",
  statusLabelTheme: () => "Tema",
  statusLabelPot: () => "Pote",
  statusLabelPlayers: () => "Jogadores",
  statusLabelGameId: () => "ID do jogo",
  gameStatus: (status, round, total) =>
    status === "ROUND" ? `RODADA ${round}/${total}` : (PT_BR_STATUS[status] ?? status),
  statusPoints: (points) => `${points} pts`,
  unknownDm: (botAcct) =>
    `Não entendi. Envie "accept"/"decline"/"cancel", ou um link do YouTube com sua faixa. Para iniciar um jogo, me mencione publicamente: @${botAcct} newgame "<tema>" 8-12 @amigo`,
  noInvitation: () => "Nenhum convite pendente encontrado para você.",
  cancelDone: (theme) =>
    `🚫 Jogo "${theme}" cancelado — sem campeão, sem pote. As pontuações ficam apenas como registro histórico.`,
  cancelNothing: () =>
    'Nenhum jogo aberto seu para cancelar. Apenas o anfitrião pode cancelar, e só enquanto o duelo está aberto (DM "cancel").',
  declined: () => "Recusado. Boa sorte por aí.",
  youAreIn: () => "Você está dentro! 🎵",
  submitFirst: (len) =>
    `Envie a faixa 1 de ${len} — responda apenas com um link do YouTube. A ordem = ordem de execução.`,
  invitationError: () => "Não foi possível processar a resposta ao convite.",
  noCollecting: () => "Nenhum jogo está coletando submissões suas no momento.",
  notPlayable: (url) => `Link do YouTube não reproduzível: ${url}`,
  alreadyInPlaylist: () => "Já está na sua playlist.",
  tuneAcceptedComplete: (pos, len, title) =>
    `✅ Faixa ${pos}/${len}: ${title}\nPlaylist completa!`,
  tuneAcceptedMore: (pos, len, title, next) =>
    `✅ Faixa ${pos}/${len}: ${title}\nEnvie a faixa ${next} de ${len}.`,
  resolveVideoError: () => "Não foi possível resolver esse vídeo.",
  linkRejected: () => "Esse link foi rejeitado.",
  tuneReplaced: (pos, len, title) =>
    `🔁 Faixa ${pos}/${len} substituída: ${title}`,
  replaceTuneDm: (pos, round, title, deadline) =>
    `⚠️ A faixa ${pos} ("${title}") da Rodada ${round} não está mais disponível.\n` +
    `Envie um link do YouTube de substituição até ${deadline}, ou responda "replace ${pos} <url>".\n` +
    `Sem substituição → você perde apenas a Rodada ${round}.`,
  duelStart: (theme, rounds, players) =>
    `⚔️ DUELO INICIADO — "${theme}"\n` +
    `${rounds} rodadas · ${players} jogadores\n` +
    `Cada voto = 1 ponto. Vencedores da rodada levam o pote. A Rodada 1 começa abaixo!`,

  roundAnnounce: (round, total, theme, standings, pot, playing) =>
    `🔔 Rodada ${round}/${total} — "${theme}"\n` +
    `Vote na faixa que melhor combina com o tema: "${theme}"\n` +
    `Placar: ${standings}\n` +
    `Pote: ${pot} · Jogadores nesta rodada: ${playing}`,
  tuneLine: (acct, title) => `🎵 @${acct} — ${title}`,
  pollPrompt: (round) =>
    `🗳️ Vote na melhor faixa da Rodada ${round}! Qualquer pessoa pode votar.`,
  resolutionWalkover: (round, acct, pot) =>
    `🚶 Rodada ${round}: W.O. — @${acct} vence sem oposição e leva o pote (+${pot}).`,
  resolutionTie: (round, newPot) =>
    `🤝 Rodada ${round}: EMPATE — sem vencedor. O pote sobe para ${newPot}.`,
  resolutionFinalTie: (round, total, each) =>
    `🤝 Rodada ${round}: EMPATE NA FINAL — pote de ${total} dividido em ${each} ponto(s) para cada jogador empatado.`,
  resolutionWin: (round, acct, bonus) =>
    `🏆 Rodada ${round}: @${acct} venceu!${bonus > 0 ? ` + bônus do pote ${bonus}` : ""}`,
  standingsLine: (standings) => `Placar: ${standings}`,
  potLine: (pot) => `Pote: ${pot}`,
  sharedChampionship: (handles) => `🏆 Campeonato compartilhado: ${handles}!`,
  champion: (handle) => `🏆 Campeão: ${handle}!`,
  finaleTheme: (theme, rounds) => `Tema: "${theme}" · ${rounds} rodadas`,
  finaleStandings: (standings) => `Placar final: ${standings}`,
  finalePotSplit: (total, each, count) =>
    `Empate na rodada final: pote de ${total} dividido em ${each} ponto(s) cada entre ${count} jogador(es) empatado(s) (sobra descartada).`,
  finaleDuelLink: (threadId) => `Duelo completo: raiz da cadeia de respostas ${threadId}`,
  finaleQueue: () => "▶️ Batalha completa, na ordem:",
  finaleWinningTune: (round, acct, title) => `🎵 Vencedor da rodada ${round} @${acct} — ${title}`,
  playlistTitle: (theme, rounds) => `Batalha de Playlists — ${theme} (${rounds} rodadas)`,
  playlistDescription: (theme, rounds) =>
    `Vencedores das rodadas de uma Batalha de Playlists com o tema "${theme}" (${rounds} rodadas).`,
  sideExpired: (theme) =>
    `⌛ Jogo "${theme}" expirou — nenhum desafiante aceitou o convite a tempo.`,
  sideFizzled: (theme) =>
    `💨 Jogo "${theme}" esvaziou — nenhuma playlist completa foi enviada antes do prazo.`,
  sideForfeit: (theme) =>
    `⚠️ Jogo "${theme}" encerrado — a conta de um jogador foi excluída ou está inacessível. Sem campeão coroado.`,
  sideCancelled: (theme) => `🚫 Jogo "${theme}" cancelado pelo anfitrião.`,
  sideDefaultWin: (theme, winnerAcct) =>
    `🎖️ Jogo "${theme}": apenas uma playlist completa — @${winnerAcct} vence por padrão (o último em pé)!`,
};

const catalogs: Record<Locale, Messages> = { en, "pt-BR": ptBR };

let current: Messages = en;

export function setLocale(locale: Locale): void {
  current = catalogs[locale] ?? en;
}

/** Active message catalog — call as `m().someKey(...)`. */
export function m(): Messages {
  return current;
}
