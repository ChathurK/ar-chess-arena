/**
 * chess-engine.js
 * ===============
 * A thin, intention-revealing wrapper around chess.js.
 *
 * WHY WRAP IT AT ALL
 * ------------------
 * chess.js is excellent but its API is designed for chess programmers, not for
 * a 3D scene. The scene code wants to ask questions like "which squares can
 * this piece legally reach, and which of those are captures?" — so those
 * questions are answered once, here, and both AR modes share the answers.
 *
 * Two behaviours of chess.js 1.x that this wrapper deliberately smooths over:
 *   • `move()` THROWS on an illegal move rather than returning null, which is
 *     awkward when illegal taps are a completely normal user action;
 *   • promotion must be supplied explicitly, and this project auto-promotes to
 *     a queen (a documented simplification — no promotion picker UI).
 *
 * IMPORTANT: this engine is only ever the *client's* opinion. In Duel Mode the
 * server keeps its own chess.js instance and is the single source of truth;
 * this one exists purely so the interface can respond instantly to a tap
 * without a network round trip.
 */

import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/dist/esm/chess.js';

/** Pawn promotions are always to a queen in this project. */
export const AUTOMATIC_PROMOTION_PIECE = 'q';

export class ChessEngine {
  /**
   * @param {string} [startingFen] A FEN string, or omitted for the standard
   *   opening position.
   */
  constructor(startingFen) {
    this.chess = startingFen ? new Chess(startingFen) : new Chess();
  }

  /* --------------------------------------------------------------------- *
   * Reading the position
   * --------------------------------------------------------------------- */

  /** The full position as a FEN string — what gets sent over the network. */
  getFen() {
    return this.chess.fen();
  }

  /** Which side is to move: 'w' or 'b'. */
  getSideToMove() {
    return this.chess.turn();
  }

  /**
   * Every occupied square, as a flat list the 3D scene can iterate directly.
   * @returns {Array<{square: string, type: string, colour: string}>}
   */
  listOccupiedSquares() {
    const occupiedSquares = [];
    for (const boardRow of this.chess.board()) {
      for (const boardCell of boardRow) {
        if (boardCell) {
          occupiedSquares.push({
            square: boardCell.square,
            type: boardCell.type,
            colour: boardCell.color,
          });
        }
      }
    }
    return occupiedSquares;
  }

  /** The piece on a square, or null when the square is empty. */
  getPieceAt(square) {
    const piece = this.chess.get(square);
    return piece ? { type: piece.type, colour: piece.color } : null;
  }

  /** True when the given square holds a piece belonging to `colour`. */
  isSquareOccupiedBy(square, colour) {
    const piece = this.getPieceAt(square);
    return piece !== null && piece.colour === colour;
  }

  /**
   * Where the king of a given colour stands. Used to paint the check
   * highlight; returns null in the (impossible in a real game, possible in a
   * hand-written puzzle FEN) case of a missing king.
   */
  findKingSquare(colour) {
    const kingEntry = this.listOccupiedSquares().find(
      (entry) => entry.type === 'k' && entry.colour === colour
    );
    return kingEntry ? kingEntry.square : null;
  }

  /* --------------------------------------------------------------------- *
   * Legal moves
   * --------------------------------------------------------------------- */

  /**
   * Every legal destination for the piece on `fromSquare`.
   *
   * The `isCapture` flag lets the scene paint capture targets in a different
   * colour from quiet moves, which makes the board far easier to read at a
   * glance on a small phone screen.
   *
   * @returns {Array<{to: string, isCapture: boolean, isPromotion: boolean}>}
   */
  listLegalDestinations(fromSquare) {
    const verboseMoves = this.chess.moves({ square: fromSquare, verbose: true });

    // A promotion produces four entries for the same destination (one per
    // promotion piece), so collapse them — this project always promotes to a
    // queen, and the scene should only ever draw one highlight per square.
    const destinationsBySquare = new Map();
    for (const move of verboseMoves) {
      if (!destinationsBySquare.has(move.to)) {
        destinationsBySquare.set(move.to, {
          to: move.to,
          isCapture: Boolean(move.captured),
          isPromotion: Boolean(move.promotion),
        });
      }
    }
    return Array.from(destinationsBySquare.values());
  }

  /** Whether a specific from → to move is legal in the current position. */
  isMoveLegal(fromSquare, toSquare) {
    return this.listLegalDestinations(fromSquare).some((destination) => destination.to === toSquare);
  }

  /* --------------------------------------------------------------------- *
   * Making moves
   * --------------------------------------------------------------------- */

  /**
   * Attempt a move.
   *
   * Never throws: an illegal move is an ordinary outcome (the user tapped a
   * square the piece cannot reach) and is reported as `{ ok: false }`.
   *
   * @returns {{ok: true, move: object, status: object} | {ok: false, reason: string}}
   */
  applyMove(fromSquare, toSquare) {
    const matchingDestination = this.listLegalDestinations(fromSquare).find(
      (destination) => destination.to === toSquare
    );
    if (!matchingDestination) {
      return { ok: false, reason: 'illegal-move' };
    }

    const moveRequest = { from: fromSquare, to: toSquare };
    if (matchingDestination.isPromotion) {
      moveRequest.promotion = AUTOMATIC_PROMOTION_PIECE;
    }

    let appliedMove;
    try {
      appliedMove = this.chess.move(moveRequest);
    } catch (moveError) {
      // Should be unreachable because legality was checked above, but a
      // rejected move must never take the whole scene down with it.
      return { ok: false, reason: 'rejected-by-engine' };
    }

    return {
      ok: true,
      move: {
        from: appliedMove.from,
        to: appliedMove.to,
        piece: appliedMove.piece,
        colour: appliedMove.color,
        captured: appliedMove.captured || null,
        promotion: appliedMove.promotion || null,
        san: appliedMove.san,
      },
      status: this.getStatus(),
    };
  }

  /**
   * Replace the whole position, e.g. when the server sends an authoritative
   * FEN after an opponent's move. Returns false rather than throwing if the
   * FEN is malformed, so a bad packet cannot break the scene.
   */
  loadFen(fen) {
    try {
      this.chess.load(fen);
      return true;
    } catch (loadError) {
      console.error('[chess-engine] refused to load an invalid FEN:', fen, loadError);
      return false;
    }
  }

  /** Take back the most recent move (used by Puzzle Mode's retry button). */
  undoLastMove() {
    return this.chess.undo();
  }

  /** How many half-moves (plies) have been played from the starting position. */
  countHalfMovesPlayed() {
    return this.chess.history().length;
  }

  /* --------------------------------------------------------------------- *
   * Game state
   * --------------------------------------------------------------------- */

  /**
   * A single snapshot of everything the UI needs to describe the position.
   * @returns {{sideToMove: string, isCheck: boolean, isCheckmate: boolean,
   *            isDraw: boolean, isGameOver: boolean, isStalemate: boolean}}
   */
  getStatus() {
    return {
      sideToMove: this.chess.turn(),
      isCheck: this.chess.isCheck(),
      isCheckmate: this.chess.isCheckmate(),
      isDraw: this.chess.isDraw(),
      isStalemate: this.chess.isStalemate(),
      isGameOver: this.chess.isGameOver(),
    };
  }
}
