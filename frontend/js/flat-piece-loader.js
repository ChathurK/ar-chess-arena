/**
 * flat-piece-loader.js
 * =====================
 * Puzzle Mode's piece representation: a flat, upward-facing icon standing in
 * for each piece, instead of a 3D model.
 *
 * WHY PUZZLE MODE DOESN'T USE 3D MODELS
 * --------------------------------------
 * Marker-based AR is viewed close to directly above the board — the marker
 * lies flat on a table and the phone looks down at it. From that angle a 3D
 * piece foreshortens down to its crown, and every piece's crown looks much
 * like every other piece's crown. A flat icon lying on the square it
 * occupies is legible from that same angle by construction: there is no
 * "wrong way" to look at a decal. As a side benefit, Puzzle Mode now has
 * nothing to download — the six .glb files, the loading curtain's progress
 * bar, and raycasts that could miss a thin foreshortened model all go away.
 *
 * Duel Mode is unaffected: it still uses PieceLoader and the 3D models in
 * piece-loader.js, because a player there walks around a room-scale board
 * and views it from a normal, roughly-level angle — exactly where a 3D piece
 * earns its keep.
 *
 * This class exposes the same shape PieceLoader does (`loadAllPieces`,
 * `createPiece`), so BoardView and puzzle-scene.js don't need to know or
 * care which one they were handed.
 */

import { PIECE_COLOURS } from './config.js';

const PIECE_ICON_GLYPHS = {
  p: '♙',
  r: '♖',
  n: '♘',
  b: '♗',
  q: '♕',
  k: '♔',
};

/** Diameter of a piece's icon disc, in board units (one square = one unit). */
const ICON_DIAMETER = 0.82;
/** How far above the tile surface the icon sits, to avoid z-fighting. */
const ICON_HEIGHT = 0.012;

export class FlatPieceLoader {
  /**
   * @param {object} options
   * @param {object} options.THREE The caller's Three.js namespace (see the
   *   note in piece-loader.js — the same reasoning applies here).
   */
  constructor({ THREE }) {
    this.THREE = THREE;
    this.templatesByKey = new Map();
    this.hasLoaded = false;
  }

  /** Cache key for a template, e.g. "wq" for a white queen. */
  static templateKey(pieceType, pieceColour) {
    return `${pieceColour}${pieceType}`;
  }

  /**
   * Builds every piece template.
   *
   * Kept `async` and given the same `(loadedCount, totalCount)` progress
   * callback as PieceLoader.loadAllPieces, purely so puzzle-scene.js can
   * `await` and report progress exactly as it did before — even though
   * drawing a canvas never actually waits on anything.
   */
  async loadAllPieces(onProgress) {
    if (this.hasLoaded) {
      return;
    }

    const pieceTypes = Object.keys(PIECE_ICON_GLYPHS);
    const pieceColours = Object.keys(PIECE_COLOURS);
    const totalCount = pieceTypes.length * pieceColours.length;
    let builtCount = 0;

    for (const pieceType of pieceTypes) {
      for (const pieceColour of pieceColours) {
        this.templatesByKey.set(
          FlatPieceLoader.templateKey(pieceType, pieceColour),
          this.buildTemplate(pieceType, pieceColour)
        );
        builtCount += 1;
        if (onProgress) {
          onProgress(builtCount, totalCount);
        }
      }
    }

    this.hasLoaded = true;
  }

  /** Draw one icon disc as a 2D canvas, ready to become a texture. */
  static drawIconCanvas(pieceType, pieceColour) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d');

    const chipColour = pieceColour === 'w' ? '#f2ead8' : '#2f3336';
    const inkColour = pieceColour === 'w' ? '#1b1814' : '#e8dcc0';

    context.beginPath();
    context.arc(64, 64, 58, 0, Math.PI * 2);
    context.fillStyle = chipColour;
    context.fill();
    context.lineWidth = 6;
    context.strokeStyle = inkColour;
    context.stroke();

    context.fillStyle = inkColour;
    context.font = '80px "Segoe UI Symbol", "DejaVu Sans", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(PIECE_ICON_GLYPHS[pieceType], 64, 68);

    return canvas;
  }

  /** Build the one template a piece type/colour's clones are drawn from. */
  buildTemplate(pieceType, pieceColour) {
    const THREE = this.THREE;
    const canvas = FlatPieceLoader.drawIconCanvas(pieceType, pieceColour);
    const texture = new THREE.CanvasTexture(canvas);

    const iconMesh = new THREE.Mesh(
      new THREE.CircleGeometry(ICON_DIAMETER / 2, 32),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true })
    );
    // A circle's default normal is +Z; tip it flat so it faces +Y (straight
    // up) — the way the player is looking down at a marker-based board.
    iconMesh.rotation.x = -Math.PI / 2;
    iconMesh.position.y = ICON_HEIGHT;
    iconMesh.name = 'pieceIcon';

    // Wrapped in a group, matching PieceLoader's contract: the object handed
    // to BoardView has its origin at the centre of the piece's base, so
    // positioning it on a square is a single `position.set`.
    const pieceGroup = new THREE.Group();
    pieceGroup.add(iconMesh);
    return pieceGroup;
  }

  /**
   * A ready-to-position piece.
   *
   * @param {string} pieceType   chess.js letter: p r n b q k
   * @param {string} pieceColour chess.js colour: 'w' or 'b'
   * @returns {object} A Three.js object whose origin is the centre of the
   *   square it stands on.
   */
  createPiece(pieceType, pieceColour) {
    const template = this.templatesByKey.get(FlatPieceLoader.templateKey(pieceType, pieceColour));
    if (!template) {
      throw new Error(`[flat-piece-loader] no icon for piece "${pieceColour}${pieceType}"`);
    }

    const pieceObject = template.clone(true);
    pieceObject.name = `piece_${pieceColour}${pieceType}`;
    // Read back by the raycaster and the move animation.
    pieceObject.userData.pieceType = pieceType;
    pieceObject.userData.pieceColour = pieceColour;
    return pieceObject;
  }
}
