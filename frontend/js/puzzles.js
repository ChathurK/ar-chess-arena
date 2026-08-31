/**
 * puzzles.js
 * ==========
 * The positions used by Puzzle Mode.
 *
 * EVERY POSITION HERE HAS BEEN PROVED CORRECT BY SEARCH — none of them were
 * written down from memory. `scripts/find_puzzles.mjs` generated them and
 * `tests/verify-puzzles.mjs` re-proves, on every run, that each one:
 *
 *   • is a legal position with White to move,
 *   • is a forced mate in exactly `moveBudget` moves against ANY defence,
 *   • cannot be mated any faster, so the move budget is honest,
 *   • has exactly one first move that works, so there is one clear answer.
 *
 * Adding a puzzle therefore means running the finder, pasting the result in,
 * and running the verifier — not trusting a position that merely looks right.
 *
 * This file is deliberately free of imports so that the Node test can load the
 * very same data the browser uses, rather than a copy that could drift.
 */

export const PUZZLES = [
  {
    id: 'queen-escort',
    name: 'The Queen’s Escort',
    /** White: King e5, Queen h7. Black: King e8. */
    fen: '4k3/7Q/8/4K3/8/8/8/8 w - - 0 1',
    moveBudget: 2,
    hint: 'The queen already covers the escape squares. Bring the king one step closer and Black runs out of moves.',
    /** Recorded for the verifier; the UI never reveals it. */
    solution: { from: 'e5', to: 'e6', san: 'Ke6' },
  },
  {
    id: 'rook-ladder',
    name: 'Rook Ladder',
    /** White: King d8, Rooks a4 and b3. Black: King e2. */
    fen: '3K4/8/8/8/R7/1R6/4k3/8 w - - 0 1',
    moveBudget: 2,
    hint: 'Two rooks mate by driving the king down one rank at a time. Which rook can check without giving the king a way past?',
    solution: { from: 'a4', to: 'a2', san: 'Ra2+' },
  },
  {
    id: 'cornered',
    name: 'Cornered',
    /** White: King e7, Rooks d3 and d2. Black: King h7, pawn g5. */
    fen: '8/4K2k/8/6p1/8/3R4/3R4/8 w - - 0 1',
    moveBudget: 2,
    hint: 'The rooks are ready. The black king only has one square — take it away before you check.',
    solution: { from: 'e7', to: 'f7', san: 'Kf7' },
  },
];

/** Look a puzzle up by id, falling back to the first one. */
export function getPuzzleById(puzzleId) {
  return PUZZLES.find((puzzle) => puzzle.id === puzzleId) || PUZZLES[0];
}
