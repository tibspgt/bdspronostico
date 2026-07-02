const test = require('node:test');
const assert = require('node:assert');
const C = require('./consensus.js');

test('computeWinnerVotes tallies votes and percentages, ignores other categories', () => {
  const bets = [
    { player_id: 'a', category: 'vainqueur', pick: 'France' },
    { player_id: 'b', category: 'vainqueur', pick: 'France' },
    { player_id: 'c', category: 'vainqueur', pick: 'Brésil' },
    { player_id: 'd', category: 'vainqueur', pick: 'France' },
    { player_id: 'e', category: 'meilleur_buteur', pick: 'Mbappé' },
  ];
  assert.deepStrictEqual(C.computeWinnerVotes(bets), [
    { team: 'France', count: 3, pct: 75 },
    { team: 'Brésil', count: 1, pct: 25 },
  ]);
});

test('computeWinnerVotes returns [] with no votes', () => {
  assert.deepStrictEqual(C.computeWinnerVotes([]), []);
});

test('computeTopPicks skips AUCUN_BUT and blanks, sorts by count then name', () => {
  const bets = [
    { pick_player_name: 'Mbappé' },
    { pick_player_name: 'Mbappé' },
    { pick_player_name: 'AUCUN_BUT' },
    { pick_player_name: '' },
    { pick_player_name: 'Haaland' },
  ];
  assert.deepStrictEqual(C.computeTopPicks(bets), [
    { name: 'Mbappé', count: 2 },
    { name: 'Haaland', count: 1 },
  ]);
});

test('computeSpecialConsensus returns top answer or null', () => {
  const bets = [
    { category: 'meilleur_joueur', pick: 'Messi' },
    { category: 'meilleur_joueur', pick: 'Messi' },
    { category: 'meilleur_joueur', pick: 'Mbappé' },
  ];
  assert.deepStrictEqual(C.computeSpecialConsensus(bets, 'meilleur_joueur'), { answer: 'Messi', count: 2 });
  assert.strictEqual(C.computeSpecialConsensus(bets, 'meilleur_gardien'), null);
});

test('computeTeamWinBelief counts predicted winners, skips draws and TBD', () => {
  const matches = [
    { id: 1, home: 'France', away: 'Brésil' },
    { id: 2, home: 'Espagne', away: 'TBD' },
  ];
  const predictions = [
    { match_id: 1, score_home: 2, score_away: 0 },
    { match_id: 1, score_home: 1, score_away: 1 },
    { match_id: 1, score_home: 0, score_away: 3 },
    { match_id: 2, score_home: 5, score_away: 0 },
    { match_id: 2, score_home: 0, score_away: 1 },
  ];
  assert.deepStrictEqual(C.computeTeamWinBelief(predictions, matches), [
    { team: 'Brésil', winVotes: 1 },
    { team: 'Espagne', winVotes: 1 },
    { team: 'France', winVotes: 1 },
  ]);
});

test('computeMatchConsensus computes distribution and top picks for one match', () => {
  const match = { id: 1, home: 'France', away: 'Brésil' };
  const predictions = [
    { match_id: 1, score_home: 2, score_away: 0 },
    { match_id: 1, score_home: 1, score_away: 0 },
    { match_id: 1, score_home: 1, score_away: 1 },
    { match_id: 1, score_home: 0, score_away: 2 },
    { match_id: 2, score_home: 9, score_away: 0 },
  ];
  const scorerBets = [
    { match_id: 1, pick_player_name: 'Mbappé' },
    { match_id: 1, pick_player_name: 'Mbappé' },
    { match_id: 1, pick_player_name: 'AUCUN_BUT' },
  ];
  const motmBets = [{ match_id: 1, pick_player_name: 'Griezmann' }];
  const res = C.computeMatchConsensus({ matchId: 1, match, predictions, scorerBets, motmBets });
  assert.strictEqual(res.n, 4);
  assert.deepStrictEqual(res.outcomeDist, { home: 50, draw: 25, away: 25 });
  assert.deepStrictEqual(res.topScorer, { name: 'Mbappé', count: 2 });
  assert.deepStrictEqual(res.topMotm, { name: 'Griezmann', count: 1 });
});

test('computeMatchConsensus with no predictions returns zeros and nulls', () => {
  const res = C.computeMatchConsensus({ matchId: 99, match: { id: 99, home: 'A', away: 'B' }, predictions: [], scorerBets: [], motmBets: [] });
  assert.strictEqual(res.n, 0);
  assert.deepStrictEqual(res.outcomeDist, { home: 0, draw: 0, away: 0 });
  assert.strictEqual(res.topScorer, null);
  assert.strictEqual(res.topMotm, null);
});
