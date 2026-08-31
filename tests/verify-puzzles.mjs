/**
 * verify-puzzles.mjs
 * ==================
 * Proves that every puzzle shipped in frontend/js/puzzles.js is exactly what
 * it claims to be. Run with `npm run puzzles:verify`.
 *
 * A puzzle that is subtly wrong — mate in one when the UI allows two moves, an
 * escape square nobody spotted, two different solutions — would be a visible
 * bug in a graded demo, and it is the kind of bug that only shows up when
 * somebody tries the puzzle in front of an audience. So the same search that
 * generated these positions runs again here, against the data the browser
 * actually loads, every time the test suite runs.
 */

import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { PUZZLES } from '../frontend/js/puzzles.js';

/* The two search functions below mirror scripts/find_puzzles.mjs. They are
 * intentionally duplicated rather than shared: a test that imports its own
 * expectations from the code under test proves very little, and an independent
 * re-implementation catches a mistake in either copy. */

function canForceMate(chess, attackerMovesRemaining) {
  if (attackerMovesRemaining <= 0) {
    return false;
  }
  for (const attackerMove of chess.moves({ verbose: true })) {
    chess.move(attackerMove);
    let attackerMoveWorks;
    if (chess.isCheckmate()) {
      attackerMoveWorks = true;
    } else if (chess.isGameOver() || attackerMovesRemaining === 1) {
      attackerMoveWorks = false;
    } else {
      attackerMoveWorks = chess.moves({ verbose: true }).every((defenderMove) => {
        chess.move(defenderMove);
        const stillForced = canForceMate(chess, attackerMovesRemaining - 1);
        chess.undo();
        return stillForced;
      });
    }
    chess.undo();
    if (attackerMoveWorks) {
      return true;
    }
  }
  return false;
}

function findForcingFirstMoves(fen, moveBudget) {
  const chess = new Chess(fen);
  const forcingFirstMoves = [];
  for (const candidateMove of chess.moves({ verbose: true })) {
    chess.move(candidateMove);
    let isForcing;
    if (chess.isCheckmate()) {
      isForcing = moveBudget >= 1;
    } else if (chess.isGameOver() || moveBudget === 1) {
      isForcing = false;
    } else {
      isForcing = chess.moves({ verbose: true }).every((defenderMove) => {
        chess.move(defenderMove);
        const stillForced = canForceMate(chess, moveBudget - 1);
        chess.undo();
        return stillForced;
      });
    }
    chess.undo();
    if (isForcing) {
      forcingFirstMoves.push(candidateMove);
    }
  }
  return forcingFirstMoves;
}

/**
 * Play the recorded solution against every possible Black defence and assert
 * that checkmate always arrives within the advertised budget. This is a
 * different question from "a forced mate exists": it checks the exact move the
 * data file records, which is the one the hint is written for.
 */
function assertSolutionAlwaysMates(puzzle) {
  const chess = new Chess(puzzle.fen);
  const playedMove = chess.move({ from: puzzle.solution.from, to: puzzle.solution.to });
  assert.ok(playedMove, `${puzzle.id}: recorded solution move is not legal`);
  assert.equal(
    playedMove.san,
    puzzle.solution.san,
    `${puzzle.id}: recorded SAN does not match the move actually played`
  );

  if (chess.isCheckmate()) {
    return; // mate in one is only valid if the budget says one
  }
  assert.ok(
    !chess.isGameOver(),
    `${puzzle.id}: the solution move ends the game without mate (probably stalemate)`
  );
  for (const defenderMove of chess.moves({ verbose: true })) {
    chess.move(defenderMove);
    assert.ok(
      canForceMate(chess, puzzle.moveBudget - 1),
      `${puzzle.id}: after the solution move, Black's reply ${defenderMove.san} escapes mate`
    );
    chess.undo();
  }
}

function main() {
  assert.ok(PUZZLES.length > 0, 'no puzzles are defined');

  const seenPuzzleIds = new Set();
  for (const puzzle of PUZZLES) {
    process.stdout.write(`${puzzle.id.padEnd(16)} `);

    assert.ok(!seenPuzzleIds.has(puzzle.id), `duplicate puzzle id: ${puzzle.id}`);
    seenPuzzleIds.add(puzzle.id);

    // 1. The position must be legal, with White to move and moves available.
    const chess = new Chess(puzzle.fen);
    assert.equal(chess.turn(), 'w', `${puzzle.id}: puzzles must start with White to move`);
    assert.ok(!chess.isGameOver(), `${puzzle.id}: the position is already over`);

    // 2. No faster mate exists, so the advertised budget is honest.
    assert.equal(
      findForcingFirstMoves(puzzle.fen, puzzle.moveBudget - 1).length,
      0,
      `${puzzle.id}: mate is actually forced in fewer than ${puzzle.moveBudget} moves`
    );

    // 3. A forced mate exists within the budget, by exactly one first move.
    const forcingFirstMoves = findForcingFirstMoves(puzzle.fen, puzzle.moveBudget);
    assert.equal(
      forcingFirstMoves.length,
      1,
      `${puzzle.id}: expected exactly one solution, found ${forcingFirstMoves.length}` +
        ` (${forcingFirstMoves.map((move) => move.san).join(', ')})`
    );
    assert.equal(
      forcingFirstMoves[0].san,
      puzzle.solution.san,
      `${puzzle.id}: the recorded solution is not the move the search found`
    );

    // 4. The recorded solution really does mate against every defence.
    assertSolutionAlwaysMates(puzzle);

    console.log(`OK  mate in ${puzzle.moveBudget}, unique key move ${puzzle.solution.san}`);
  }

  console.log(`\nAll ${PUZZLES.length} puzzles verified.`);
}

main();
