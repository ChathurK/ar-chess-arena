/**
 * find_puzzles.mjs
 * ================
 * Searches for verifiably correct "mate in N" positions for Puzzle Mode.
 *
 * WHY SEARCH RATHER THAN JUST WRITING A FEN DOWN
 * ----------------------------------------------
 * Chess puzzle correctness is deceptively easy to get wrong from memory: an
 * escape square nobody noticed, a mate that turns out to be one move quicker,
 * a "forced" line that a defender can sidestep. A broken puzzle in a graded
 * demo would be an obvious and avoidable bug, so no position is trusted here
 * unless a search has proved it.
 *
 * WHAT COUNTS AS A GOOD PUZZLE (all four must hold)
 * -------------------------------------------------
 *   1. the position is legal and it is White to move,
 *   2. White can force mate in exactly N moves against every Black defence,
 *   3. White cannot mate any faster (otherwise the move budget is wrong),
 *   4. exactly one first move works, so the puzzle has a single clear answer.
 *
 * Usage:  npm run puzzles:find -- [--mate-in 2] [--wanted 3] [--seed 12345]
 */

import { Chess } from 'chess.js';

/* ------------------------------------------------------------------------ *
 * Forced-mate search
 * ------------------------------------------------------------------------ */

/**
 * Can the side to move force checkmate within `attackerMovesRemaining` moves?
 *
 * This is an "AND/OR" search: the attacker needs only ONE move that works,
 * while the defender must have NO reply that escapes. Stalemate counts as a
 * failure for the attacker, which is the classic trap in mate problems.
 */
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
      // Either the game ended without mate (stalemate, insufficient material,
      // a draw) or the attacker has run out of moves to deliver mate with.
      attackerMoveWorks = false;
    } else {
      // Every single defensive reply must still lose to a faster mate.
      attackerMoveWorks = chess
        .moves({ verbose: true })
        .every((defenderMove) => {
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

/** Every first move that forces mate within `moveBudget` moves. */
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

/* ------------------------------------------------------------------------ *
 * Random legal positions
 * ------------------------------------------------------------------------ */

const FILE_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

/**
 * A tiny seeded random number generator (mulberry32).
 *
 * Seeded rather than Math.random so that a puzzle search is reproducible: the
 * same seed always yields the same puzzles, which matters when the results are
 * about to be hard-coded into the application.
 */
function createSeededRandom(seed) {
  let state = seed >>> 0;
  return function nextRandom() {
    state = (state + 0x6d2b79f5) >>> 0;
    let scrambled = Math.imul(state ^ (state >>> 15), 1 | state);
    scrambled = (scrambled + Math.imul(scrambled ^ (scrambled >>> 7), 61 | scrambled)) ^ scrambled;
    return ((scrambled ^ (scrambled >>> 14)) >>> 0) / 4294967296;
  };
}

function squareFromIndex(squareIndex) {
  return FILE_LETTERS[squareIndex % 8] + String(Math.floor(squareIndex / 8) + 1);
}

/** Chebyshev distance — kings may never stand within one square of each other. */
function areKingsAdjacent(firstSquareIndex, secondSquareIndex) {
  const fileDistance = Math.abs((firstSquareIndex % 8) - (secondSquareIndex % 8));
  const rankDistance = Math.abs(Math.floor(firstSquareIndex / 8) - Math.floor(secondSquareIndex / 8));
  return Math.max(fileDistance, rankDistance) <= 1;
}

/**
 * Material recipes to try. Each entry lists the pieces beyond the two kings,
 * uppercase for White and lowercase for Black, and they are kept deliberately
 * sparse: a three or four piece position is instantly readable on a phone
 * screen and needs no chess experience to attempt.
 */
const MATERIAL_RECIPES = [
  ['Q'],
  ['R', 'R'],
  ['Q', 'R'],
  ['R', 'B'],
  ['Q', 'N'],
  ['R', 'R', 'p'],
  ['Q', 'B', 'p'],
];

/** Build a FEN from a placement map, or null when the position is illegal. */
function buildLegalFen(placementBySquareIndex) {
  const boardRows = [];
  for (let rankIndex = 7; rankIndex >= 0; rankIndex -= 1) {
    let rowText = '';
    let emptyRun = 0;
    for (let fileIndex = 0; fileIndex < 8; fileIndex += 1) {
      const pieceLetter = placementBySquareIndex.get(rankIndex * 8 + fileIndex);
      if (pieceLetter) {
        if (emptyRun > 0) {
          rowText += emptyRun;
          emptyRun = 0;
        }
        rowText += pieceLetter;
      } else {
        emptyRun += 1;
      }
    }
    if (emptyRun > 0) {
      rowText += emptyRun;
    }
    boardRows.push(rowText);
  }
  const fen = `${boardRows.join('/')} w - - 0 1`;

  // chess.js rejects structurally invalid FENs, but a position can be well
  // formed and still impossible, so the side-not-to-move is checked for check
  // separately below.
  let chess;
  try {
    chess = new Chess(fen);
  } catch (invalidFenError) {
    return null;
  }

  // With White to move, Black must not already be in check — that position
  // could never arise from a real game.
  const blackToMoveFen = fen.replace(' w ', ' b ');
  try {
    if (new Chess(blackToMoveFen).isCheck()) {
      return null;
    }
  } catch (invalidFenError) {
    return null;
  }

  // The position must also not be over already, and White must have moves.
  if (chess.isGameOver() || chess.moves().length === 0) {
    return null;
  }
  return fen;
}

/** Scatter a recipe's pieces onto empty squares and return a legal FEN. */
function generateCandidatePosition(nextRandom, recipe) {
  const usedSquareIndices = new Set();
  const placement = new Map();

  const pickFreeSquare = () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const squareIndex = Math.floor(nextRandom() * 64);
      if (!usedSquareIndices.has(squareIndex)) {
        usedSquareIndices.add(squareIndex);
        return squareIndex;
      }
    }
    return null;
  };

  const whiteKingSquare = pickFreeSquare();
  const blackKingSquare = pickFreeSquare();
  if (whiteKingSquare === null || blackKingSquare === null) {
    return null;
  }
  if (areKingsAdjacent(whiteKingSquare, blackKingSquare)) {
    return null;
  }
  placement.set(whiteKingSquare, 'K');
  placement.set(blackKingSquare, 'k');

  for (const pieceLetter of recipe) {
    const squareIndex = pickFreeSquare();
    if (squareIndex === null) {
      return null;
    }
    // Pawns cannot legally stand on the first or last rank.
    const rankIndex = Math.floor(squareIndex / 8);
    if (pieceLetter.toLowerCase() === 'p' && (rankIndex === 0 || rankIndex === 7)) {
      return null;
    }
    placement.set(squareIndex, pieceLetter);
  }

  return buildLegalFen(placement);
}

/* ------------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------------ */

function readCommandLineOption(optionName, defaultValue) {
  const optionIndex = process.argv.indexOf(optionName);
  return optionIndex === -1 ? defaultValue : Number(process.argv[optionIndex + 1]);
}

function main() {
  const mateInMoves = readCommandLineOption('--mate-in', 2);
  const wantedPuzzleCount = readCommandLineOption('--wanted', 3);
  const randomSeed = readCommandLineOption('--seed', 20260831);
  const maximumAttempts = readCommandLineOption('--attempts', 40000);

  const nextRandom = createSeededRandom(randomSeed);
  const foundPuzzles = [];
  let attemptCount = 0;

  console.log(
    `Searching for ${wantedPuzzleCount} mate-in-${mateInMoves} puzzles ` +
      `(seed ${randomSeed}, up to ${maximumAttempts} attempts)…\n`
  );

  while (foundPuzzles.length < wantedPuzzleCount && attemptCount < maximumAttempts) {
    attemptCount += 1;
    const recipe = MATERIAL_RECIPES[Math.floor(nextRandom() * MATERIAL_RECIPES.length)];
    const fen = generateCandidatePosition(nextRandom, recipe);
    if (!fen) {
      continue;
    }

    // Requirement 3: reject anything that mates sooner than advertised.
    if (findForcingFirstMoves(fen, mateInMoves - 1).length > 0) {
      continue;
    }

    // Requirements 2 and 4: forced mate, by exactly one first move.
    const forcingFirstMoves = findForcingFirstMoves(fen, mateInMoves);
    if (forcingFirstMoves.length !== 1) {
      continue;
    }

    const keyMove = forcingFirstMoves[0];
    foundPuzzles.push({ fen, recipe: recipe.join(''), keyMove });

    console.log(`FOUND after ${attemptCount} attempts`);
    console.log(`  fen      : ${fen}`);
    console.log(`  material : K${recipe.join('')} vs k`);
    console.log(`  key move : ${keyMove.san}  (${keyMove.from} → ${keyMove.to})\n`);
  }

  if (foundPuzzles.length < wantedPuzzleCount) {
    console.log(`Only found ${foundPuzzles.length} puzzle(s) in ${attemptCount} attempts.`);
    process.exitCode = 1;
  } else {
    console.log(`Done — ${foundPuzzles.length} verified puzzles in ${attemptCount} attempts.`);
  }
}

main();
