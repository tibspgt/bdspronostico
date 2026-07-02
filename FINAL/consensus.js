/**
 * Consensus stat computations for BDS Pronostico.
 * Pure functions — no DOM, no globals read. Loads as a classic <script> in the
 * browser (attaches `Consensus` to globalThis) and as a CommonJS module in Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Consensus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Tally an array of raw strings into [{name,count}] sorted by count desc, then name.
  function tally(names) {
    const counts = new Map();
    for (const raw of names) {
      const name = (raw || '').trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'fr'));
  }

  // Most-picked scorer/MOTM names (both tables use pick_player_name).
  // Skips the "no goal" sentinel and blanks.
  function computeTopPicks(bets, limit = 5) {
    const names = (bets || [])
      .map(b => b.pick_player_name)
      .filter(n => n && n !== 'AUCUN_BUT');
    const ranked = tally(names);
    return Number.isFinite(limit) ? ranked.slice(0, limit) : ranked;
  }

  // Tournament-winner votes from special_bets (category 'vainqueur').
  function computeWinnerVotes(specialBets) {
    const picks = (specialBets || [])
      .filter(b => b.category === 'vainqueur' && b.pick && b.pick.trim())
      .map(b => b.pick.trim());
    const total = picks.length;
    return tally(picks).map(({ name, count }) => ({
      team: name,
      count,
      pct: total ? Math.round((count / total) * 100) : 0,
    }));
  }

  // Most-picked answer for a given special_bets category.
  function computeSpecialConsensus(specialBets, category) {
    const picks = (specialBets || [])
      .filter(b => b.category === category && b.pick && b.pick.trim())
      .map(b => b.pick.trim());
    const ranked = tally(picks);
    return ranked.length ? { answer: ranked[0].name, count: ranked[0].count } : null;
  }

  // Which side a prediction backs: 'home' | 'away' | 'draw'.
  function predictedSide(pred) {
    if (pred.score_home > pred.score_away) return 'home';
    if (pred.score_home < pred.score_away) return 'away';
    return 'draw';
  }

  // Teams ranked by how often the group predicted them to win (draws & TBD excluded).
  function computeTeamWinBelief(predictions, matches, limit = 8) {
    const matchById = new Map((matches || []).map(m => [m.id, m]));
    const votes = new Map();
    for (const pred of predictions || []) {
      if (pred.score_home == null || pred.score_away == null) continue;
      const m = matchById.get(pred.match_id);
      if (!m) continue;
      const side = predictedSide(pred);
      if (side === 'draw') continue;
      const team = side === 'home' ? m.home : m.away;
      if (!team || team === 'TBD') continue;
      votes.set(team, (votes.get(team) || 0) + 1);
    }
    const ranked = [...votes.entries()]
      .map(([team, winVotes]) => ({ team, winVotes }))
      .sort((a, b) => b.winVotes - a.winVotes || a.team.localeCompare(b.team, 'fr'));
    return Number.isFinite(limit) ? ranked.slice(0, limit) : ranked;
  }

  // Per-match consensus: outcome distribution (integer %) + top scorer/MOTM pick.
  // (No `match` object needed — outputs are keyed by side, not team name.)
  function computeMatchConsensus({ matchId, predictions, scorerBets, motmBets }) {
    const preds = (predictions || []).filter(
      p => p.match_id === matchId && p.score_home != null && p.score_away != null
    );
    const n = preds.length;
    let home = 0, away = 0, draw = 0;
    for (const p of preds) {
      const side = predictedSide(p);
      if (side === 'home') home++;
      else if (side === 'away') away++;
      else draw++;
    }
    const pct = c => (n ? Math.round((c / n) * 100) : 0);
    const topScorer = computeTopPicks((scorerBets || []).filter(b => b.match_id === matchId), 1)[0] || null;
    const topMotm   = computeTopPicks((motmBets   || []).filter(b => b.match_id === matchId), 1)[0] || null;
    return { n, outcomeDist: { home: pct(home), draw: pct(draw), away: pct(away) }, topScorer, topMotm };
  }

  return {
    tally,
    computeTopPicks,
    computeWinnerVotes,
    computeSpecialConsensus,
    computeTeamWinBelief,
    computeMatchConsensus,
    predictedSide,
  };
});
