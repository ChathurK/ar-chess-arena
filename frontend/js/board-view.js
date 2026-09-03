/**
 * board-view.js
 * =============
 * The visual half of the game: a Three.js object tree that mirrors a chess
 * position, animates moves, paints highlights and turns a screen tap into a
 * square name.
 *
 * WHY THIS MODULE EXISTS (it is not in the original plan's file list)
 * -------------------------------------------------------------------
 * Puzzle Mode and Duel Mode differ only in how a move is *authorised* — one
 * checks a puzzle solution locally, the other asks a server. Everything after
 * that ("slide this piece there, remove the captured one, light up the king")
 * is identical. Keeping that shared half in one place means a rendering fix
 * made for one mode is automatically correct in the other.
 *
 * Object tree it builds:
 *
 *   rootGroup                 ← the scene positions and scales this
 *     └ orientationGroup      ← rotated 180° when the local player is Black
 *         ├ boardGroup        ← 64 tiles + frame, from board-builder.js
 *         └ piecesGroup       ← one object per piece on the board
 *
 * As elsewhere, `THREE` is injected rather than imported so that the A-Frame
 * page and the Three.js page each use their own single copy of the library.
 */

import {
  createBoard,
  setTileHighlight,
  clearAllHighlights,
  squareToLocalPosition,
  squareToIndices,
  indicesToSquare,
  localPositionToSquare,
} from './board-builder.js';
import { HIGHLIGHT_COLOURS, ANIMATION } from './config.js';

export class BoardView {
  /**
   * @param {object} options
   * @param {object} options.THREE       The caller's Three.js namespace.
   * @param {object} options.pieceLoader An already-loaded PieceLoader.
   */
  constructor({ THREE, pieceLoader }) {
    this.THREE = THREE;
    this.pieceLoader = pieceLoader;

    this.rootGroup = new THREE.Group();
    this.rootGroup.name = 'boardView';

    this.orientationGroup = new THREE.Group();
    this.orientationGroup.name = 'boardOrientation';
    this.rootGroup.add(this.orientationGroup);

    const { group: boardGroup, tilesBySquare } = createBoard(THREE);
    this.boardGroup = boardGroup;
    this.tilesBySquare = tilesBySquare;
    this.orientationGroup.add(boardGroup);

    this.piecesGroup = new THREE.Group();
    this.piecesGroup.name = 'pieces';
    this.orientationGroup.add(this.piecesGroup);

    /** @type {Map<string, object>} square → the piece object standing on it. */
    this.pieceObjectsBySquare = new Map();

    /** Animations currently in flight, advanced by `update()`. */
    this.activeAnimations = [];

    /** Highlight bookkeeping, so each kind can be cleared independently. */
    this.selectedSquare = null;
    this.highlightedTargets = [];
    this.lastMoveSquares = [];
    this.checkedKingSquare = null;

    // Scratch objects reused every raycast. Allocating these per tap would
    // create garbage on every frame the user is interacting, which is exactly
    // when a phone can least afford a collection pause.
    this.reusableRaycaster = new THREE.Raycaster();
    this.reusablePointer = new THREE.Vector2();

    // Scratch objects for the plane-fallback pick (see `pickSquareWithRaycaster`).
    this.scratchPlane = new THREE.Plane();
    this.scratchPlaneNormal = new THREE.Vector3();
    this.scratchPlanePoint = new THREE.Vector3();
    this.scratchQuaternion = new THREE.Quaternion();
    this.scratchHitPoint = new THREE.Vector3();
  }

  /** The object to add to your scene (or to an A-Frame entity). */
  get object3D() {
    return this.rootGroup;
  }

  /**
   * Turn the board around so the local player's own pieces are nearest to
   * them. Only Duel Mode uses this, and only for the Black player.
   */
  setBoardOrientation(localPlayerColour) {
    this.orientationGroup.rotation.y = localPlayerColour === 'b' ? Math.PI : 0;
  }

  /* --------------------------------------------------------------------- *
   * Building the position
   * --------------------------------------------------------------------- */

  /**
   * Discard every piece object and rebuild from the engine.
   *
   * Used at start-up and whenever an authoritative position arrives that the
   * local view might not match (a reconnect, or a FEN pushed by the server).
   * It is deliberately blunt: correctness matters more than animation when the
   * two views may have drifted apart.
   */
  rebuildFromEngine(chessEngine) {
    this.cancelAllAnimations();

    for (const pieceObject of this.pieceObjectsBySquare.values()) {
      this.disposePieceObject(pieceObject);
    }
    this.pieceObjectsBySquare.clear();

    for (const occupied of chessEngine.listOccupiedSquares()) {
      this.placeNewPiece(occupied.type, occupied.colour, occupied.square);
    }
  }

  /** Create a piece and stand it on a square. */
  placeNewPiece(pieceType, pieceColour, square) {
    const pieceObject = this.pieceLoader.createPiece(pieceType, pieceColour);
    const localPosition = squareToLocalPosition(square);
    pieceObject.position.set(localPosition.x, 0, localPosition.z);

    // Read back by the raycaster: tapping a piece has to resolve to the square
    // it is standing on, and the hit will land on a child mesh, not here.
    pieceObject.userData.square = square;

    this.piecesGroup.add(pieceObject);
    this.pieceObjectsBySquare.set(square, pieceObject);
    return pieceObject;
  }

  /**
   * Take a piece out of the scene.
   *
   * Deliberately does NOT dispose the piece's materials. `PieceLoader` hands
   * out `clone()`s, and a Three.js clone SHARES its materials with the template
   * it came from — so disposing one captured pawn's material would pull the
   * material out from under every other pawn of that colour. The loader owns
   * the twelve materials for the lifetime of the page; the geometry is shared
   * for the same reason. Removing the object from its parent is all that is
   * needed for it to stop being drawn and be collected.
   */
  disposePieceObject(pieceObject) {
    this.piecesGroup.remove(pieceObject);
    // Reset the transform the capture animation left behind, so the object is
    // in a clean state if it is ever reused.
    pieceObject.scale.setScalar(1);
  }

  /* --------------------------------------------------------------------- *
   * Playing a move
   * --------------------------------------------------------------------- */

  /**
   * Animate a move that has already been validated by an engine.
   *
   * @param {object} move A move description in the shape produced by
   *   ChessEngine.applyMove() and broadcast by the server:
   *   `{ from, to, piece, colour, captured, promotion }`.
   *
   * Handles the three moves that are not simply "one piece slides to one
   * square", each of which would otherwise leave the board visibly wrong:
   *   • captures        — the taken piece shrinks away,
   *   • en passant      — the taken pawn is NOT on the destination square,
   *   • castling        — the rook has to travel too,
   *   • promotion       — the pawn is swapped for a queen on arrival.
   */
  applyMove(move) {
    const movingPiece = this.pieceObjectsBySquare.get(move.from);
    if (!movingPiece) {
      // The view has drifted from the engine. Rather than animating nonsense,
      // let the caller know so it can force a full rebuild.
      console.warn('[board-view] no piece to move from', move.from);
      return false;
    }

    // --- 1. Remove whatever is being captured ---------------------------
    if (move.captured) {
      const capturedSquare = this.resolveCapturedSquare(move);
      const capturedPiece = this.pieceObjectsBySquare.get(capturedSquare);
      if (capturedPiece) {
        this.pieceObjectsBySquare.delete(capturedSquare);
        this.startCaptureAnimation(capturedPiece);
      }
    }

    // --- 2. Slide the moving piece --------------------------------------
    this.pieceObjectsBySquare.delete(move.from);
    // A piece already registered on the destination (a capture) has been
    // removed above, so this overwrite is always safe.
    this.pieceObjectsBySquare.set(move.to, movingPiece);
    movingPiece.userData.square = move.to;
    this.startSlideAnimation(movingPiece, move.from, move.to, () => {
      // --- 3. Promotion: swap the arrived pawn for its promoted piece ---
      if (move.promotion) {
        this.disposePieceObject(movingPiece);
        this.pieceObjectsBySquare.delete(move.to);
        this.placeNewPiece(move.promotion, move.colour, move.to);
      }
    });

    // --- 4. Castling: bring the rook across too --------------------------
    const castlingRookMove = this.resolveCastlingRookMove(move);
    if (castlingRookMove) {
      const rookPiece = this.pieceObjectsBySquare.get(castlingRookMove.from);
      if (rookPiece) {
        this.pieceObjectsBySquare.delete(castlingRookMove.from);
        this.pieceObjectsBySquare.set(castlingRookMove.to, rookPiece);
        rookPiece.userData.square = castlingRookMove.to;
        this.startSlideAnimation(rookPiece, castlingRookMove.from, castlingRookMove.to);
      }
    }

    return true;
  }

  /**
   * Which square the captured piece is actually standing on.
   *
   * For every capture except en passant that is the destination square. En
   * passant is the exception that catches people out: the pawn being taken sits
   * beside the capturing pawn's starting square, not under its destination.
   */
  resolveCapturedSquare(move) {
    if (this.pieceObjectsBySquare.has(move.to)) {
      return move.to;
    }
    const fromIndices = squareToIndices(move.from);
    const toIndices = squareToIndices(move.to);
    if (move.piece === 'p' && fromIndices && toIndices) {
      const enPassantSquare = indicesToSquare(toIndices.fileIndex, fromIndices.rankIndex);
      if (enPassantSquare && this.pieceObjectsBySquare.has(enPassantSquare)) {
        return enPassantSquare;
      }
    }
    return move.to;
  }

  /**
   * The rook's journey when a move is a castle, or null when it is not.
   * A castle is the only move in chess where a king travels two files.
   */
  resolveCastlingRookMove(move) {
    if (move.piece !== 'k') {
      return null;
    }
    const fromIndices = squareToIndices(move.from);
    const toIndices = squareToIndices(move.to);
    if (!fromIndices || !toIndices) {
      return null;
    }
    const fileDistance = toIndices.fileIndex - fromIndices.fileIndex;
    if (Math.abs(fileDistance) !== 2) {
      return null;
    }
    const rankIndex = fromIndices.rankIndex;
    return fileDistance > 0
      ? { from: indicesToSquare(7, rankIndex), to: indicesToSquare(5, rankIndex) } // king side
      : { from: indicesToSquare(0, rankIndex), to: indicesToSquare(3, rankIndex) }; // queen side
  }

  /* --------------------------------------------------------------------- *
   * Animation
   * --------------------------------------------------------------------- */

  /** Smooth acceleration and deceleration; linear motion looks mechanical. */
  static easeInOutCubic(progress) {
    return progress < 0.5
      ? 4 * progress * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 3) / 2;
  }

  /**
   * Slide a piece between two squares along a shallow arc, as though it were
   * lifted rather than dragged across the board.
   */
  startSlideAnimation(pieceObject, fromSquare, toSquare, onComplete) {
    const startPosition = squareToLocalPosition(fromSquare);
    const endPosition = squareToLocalPosition(toSquare);

    this.activeAnimations.push({
      kind: 'slide',
      pieceObject,
      startPosition,
      endPosition,
      elapsedMs: 0,
      durationMs: ANIMATION.MOVE_DURATION_MS,
      onComplete,
    });
  }

  /** Shrink a captured piece out of existence. */
  startCaptureAnimation(pieceObject) {
    this.activeAnimations.push({
      kind: 'capture',
      pieceObject,
      elapsedMs: 0,
      durationMs: ANIMATION.CAPTURE_DURATION_MS,
    });
  }

  /**
   * Advance every in-flight animation. Call once per rendered frame with the
   * time since the previous frame, in milliseconds.
   */
  update(deltaMilliseconds) {
    if (this.activeAnimations.length === 0) {
      return;
    }

    const stillRunning = [];
    for (const animation of this.activeAnimations) {
      animation.elapsedMs += deltaMilliseconds;
      const rawProgress = Math.min(1, animation.elapsedMs / animation.durationMs);

      if (animation.kind === 'slide') {
        const easedProgress = BoardView.easeInOutCubic(rawProgress);
        animation.pieceObject.position.x =
          animation.startPosition.x +
          (animation.endPosition.x - animation.startPosition.x) * easedProgress;
        animation.pieceObject.position.z =
          animation.startPosition.z +
          (animation.endPosition.z - animation.startPosition.z) * easedProgress;
        // A half sine gives a lift that starts and ends exactly on the board.
        animation.pieceObject.position.y =
          Math.sin(rawProgress * Math.PI) * ANIMATION.MOVE_ARC_HEIGHT;
      } else if (animation.kind === 'capture') {
        const remaining = 1 - rawProgress;
        animation.pieceObject.scale.setScalar(Math.max(0.001, remaining));
        animation.pieceObject.position.y = -0.35 * rawProgress;
      }

      if (rawProgress < 1) {
        stillRunning.push(animation);
      } else {
        this.finishAnimation(animation);
      }
    }
    this.activeAnimations = stillRunning;
  }

  /** Settle a finished animation onto its exact final state. */
  finishAnimation(animation) {
    if (animation.kind === 'slide') {
      animation.pieceObject.position.set(
        animation.endPosition.x,
        0,
        animation.endPosition.z
      );
      if (animation.onComplete) {
        animation.onComplete();
      }
    } else if (animation.kind === 'capture') {
      this.disposePieceObject(animation.pieceObject);
    }
  }

  /** True while any piece is still moving — used to ignore taps mid-move. */
  get isAnimating() {
    return this.activeAnimations.length > 0;
  }

  /** Snap every animation to its end state immediately. */
  cancelAllAnimations() {
    for (const animation of this.activeAnimations) {
      this.finishAnimation(animation);
    }
    this.activeAnimations = [];
  }

  /* --------------------------------------------------------------------- *
   * Highlighting
   * --------------------------------------------------------------------- */

  /**
   * Repaint every highlight from scratch.
   *
   * Highlights are layered deliberately, weakest first, so that a stronger
   * meaning always wins the square: last move → legal target → selection →
   * king in check.
   */
  refreshHighlights() {
    clearAllHighlights(this.tilesBySquare);

    for (const square of this.lastMoveSquares) {
      setTileHighlight(this.tilesBySquare.get(square), HIGHLIGHT_COLOURS.LAST_MOVE);
    }
    for (const target of this.highlightedTargets) {
      setTileHighlight(
        this.tilesBySquare.get(target.to),
        target.isCapture ? HIGHLIGHT_COLOURS.CAPTURE_TARGET : HIGHLIGHT_COLOURS.LEGAL_MOVE
      );
    }
    if (this.selectedSquare) {
      setTileHighlight(this.tilesBySquare.get(this.selectedSquare), HIGHLIGHT_COLOURS.SELECTED);
    }
    if (this.checkedKingSquare) {
      setTileHighlight(this.tilesBySquare.get(this.checkedKingSquare), HIGHLIGHT_COLOURS.KING_IN_CHECK);
    }
  }

  /**
   * Mark a piece as picked up and show where it can go.
   * @param {string|null} square
   * @param {Array<{to: string, isCapture: boolean}>} [legalTargets]
   */
  setSelection(square, legalTargets = []) {
    this.selectedSquare = square;
    this.highlightedTargets = square ? legalTargets : [];
    this.refreshHighlights();
  }

  /** Leave a faint trail on the two squares of the move just played. */
  setLastMove(fromSquare, toSquare) {
    this.lastMoveSquares = fromSquare && toSquare ? [fromSquare, toSquare] : [];
    this.refreshHighlights();
  }

  /** Flag the king that is currently in check, or pass null to clear it. */
  setCheckedKing(square) {
    this.checkedKingSquare = square;
    this.refreshHighlights();
  }

  /* --------------------------------------------------------------------- *
   * Picking (turning a tap into a square)
   * --------------------------------------------------------------------- */

  /**
   * Work out which square the user tapped.
   *
   * Casts a ray through the tapped point and returns the square of the nearest
   * hit. Both tiles and pieces are valid hits — tapping the tall king model
   * has to select e1, not whichever tile happens to be behind it — which is
   * why every piece object carries its square in `userData` too.
   *
   * @param {{clientX: number, clientY: number}} pointerEvent
   * @param {object} camera        The camera the scene is rendered with.
   * @param {HTMLElement} viewport The element the event's coordinates are
   *   relative to (normally the renderer's canvas).
   * @returns {string|null} An algebraic square, or null if the tap missed.
   */
  pickSquareAtPointer(pointerEvent, camera, viewport) {
    const viewportBounds = viewport.getBoundingClientRect();
    // Normalised device coordinates: the renderer's -1…+1 space, with +Y up.
    this.reusablePointer.x =
      ((pointerEvent.clientX - viewportBounds.left) / viewportBounds.width) * 2 - 1;
    this.reusablePointer.y =
      -((pointerEvent.clientY - viewportBounds.top) / viewportBounds.height) * 2 + 1;

    this.reusableRaycaster.setFromCamera(this.reusablePointer, camera);
    return this.pickSquareWithRaycaster(this.reusableRaycaster);
  }

  /**
   * Work out which square a ray points at.
   *
   * Duel Mode needs this form rather than the pointer form above: inside a
   * WebXR session a tap arrives as an `XRInputSource` whose target ray is
   * already expressed in world space, so there are no screen coordinates to
   * convert — the ray is simply handed straight to the raycaster.
   *
   * @param {object} raycaster A Three.js Raycaster with its ray already set.
   * @returns {string|null}
   */
  pickSquareWithRaycaster(raycaster) {
    const intersections = raycaster.intersectObject(this.rootGroup, true);
    for (const intersection of intersections) {
      const square = BoardView.findSquareOnObjectOrAncestors(intersection.object);
      if (square) {
        return square;
      }
    }
    // Nothing solid was hit — a very plausible outcome on a small marker
    // board, where a piece's actual mesh covers only a fraction of the
    // square it stands on. Rather than the tap silently doing nothing, fall
    // back to where the ray crosses the board's own plane and resolve
    // whichever square that point falls in.
    return this.pickSquareOnBoardPlane(raycaster);
  }

  /**
   * Resolve a square from where a ray crosses the board's surface plane,
   * regardless of whether it actually hit a mesh there.
   * @returns {string|null}
   */
  pickSquareOnBoardPlane(raycaster) {
    this.orientationGroup.getWorldQuaternion(this.scratchQuaternion);
    this.orientationGroup.getWorldPosition(this.scratchPlanePoint);
    this.scratchPlaneNormal.set(0, 1, 0).applyQuaternion(this.scratchQuaternion);
    this.scratchPlane.setFromNormalAndCoplanarPoint(
      this.scratchPlaneNormal,
      this.scratchPlanePoint
    );

    if (!raycaster.ray.intersectPlane(this.scratchPlane, this.scratchHitPoint)) {
      return null; // the ray runs parallel to the board — no meaningful tap
    }

    const localHitPoint = this.orientationGroup.worldToLocal(this.scratchHitPoint.clone());
    return localPositionToSquare(localHitPoint.x, localHitPoint.z);
  }

  /**
   * Walk up from a hit mesh until something knows which square it belongs to.
   * A piece's hit lands on a child mesh several levels below the object that
   * actually stores the square.
   */
  static findSquareOnObjectOrAncestors(hitObject) {
    let currentObject = hitObject;
    while (currentObject) {
      if (currentObject.userData && currentObject.userData.square) {
        return currentObject.userData.square;
      }
      currentObject = currentObject.parent;
    }
    return null;
  }
}
