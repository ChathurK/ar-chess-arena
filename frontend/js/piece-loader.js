/**
 * piece-loader.js
 * ===============
 * Loads the six generated .glb piece models once, tints them into the twelve
 * pieces a chess set actually needs, and hands out cheap clones on demand.
 *
 * WHY SIX FILES BECOME TWELVE PIECES
 * ----------------------------------
 * The generator exports each piece in a neutral ivory. Colour is a material
 * property, not geometry, so tinting at runtime halves the number of files the
 * phone has to download over what is often a mobile connection.
 *
 * THE THREE-LEVEL CACHE (this is the part worth understanding)
 * -------------------------------------------------------------
 *   1. `loadedModelsByType`  — the raw glTF scene for each of the six files,
 *                              downloaded exactly once.
 *   2. `tintedTemplates`     — one ivory and one charcoal version of each
 *                              piece: twelve objects, each owning one material.
 *   3. `createPiece()`       — returns `.clone()` of the right template. Clones
 *                              share the template's material, so all sixteen
 *                              white pawns cost one material between them.
 *
 * As with board-builder.js, the caller supplies `THREE` and `GLTFLoader` so
 * that Puzzle Mode (A-Frame's bundled Three.js) and Duel Mode (its own
 * imported Three.js) never mix objects from two different builds.
 */

import { MODEL_BASE_PATH, PIECE_MODEL_FILES, PIECE_COLOURS } from './config.js';

/**
 * One glyph per piece type, drawn onto a small disc that sits flat on top of
 * each piece and faces straight up.
 *
 * WHY THIS EXISTS
 * ----------------
 * Marker-based AR is usually viewed from close to directly above the board
 * (the marker lies flat on a table), which foreshortens every piece down to
 * its crown — from that angle a bishop and a pawn silhouette almost the same.
 * A flat icon facing the same way the player is looking solves exactly that,
 * without changing the 3D models.
 *
 * WHY IT IS OPTIONAL
 * -------------------
 * That reasoning is specific to looking straight down. Duel Mode is viewed
 * from a standing 3/4 angle, where the models already read clearly and a disc
 * floating over each crown only hides the very geometry it was meant to
 * stand in for — so Duel Mode switches them off via `showTopIcons: false`.
 */
const PIECE_TOP_ICON_GLYPHS = {
  p: '♙',
  r: '♖',
  n: '♘',
  b: '♗',
  q: '♕',
  k: '♔',
};

/** Diameter of the top icon disc, in board units (a square is 1 unit). */
const TOP_ICON_DIAMETER = 0.62;
/** Gap left between the piece's true top and the icon disc, so it doesn't z-fight. */
const TOP_ICON_CLEARANCE = 0.03;

export class PieceLoader {
  /**
   * @param {object} options
   * @param {object} options.THREE        The caller's Three.js namespace.
   * @param {Function} options.GLTFLoader The caller's GLTFLoader constructor.
   * @param {string} [options.basePath]   Where the .glb files live, relative
   *   to the HTML page. Both pages sit at the frontend root, so the default is
   *   correct for each of them.
   * @param {boolean} [options.showTopIcons] Whether to glue a flat glyph disc
   *   on top of each piece. Defaults to true, which is what a near-top-down
   *   marker board wants; see the note above `PIECE_TOP_ICON_GLYPHS`.
   */
  constructor({ THREE, GLTFLoader, basePath = MODEL_BASE_PATH, showTopIcons = true }) {
    this.THREE = THREE;
    this.basePath = basePath;
    this.showTopIcons = showTopIcons;
    this.gltfLoader = new GLTFLoader();

    this.loadedModelsByType = new Map();
    this.tintedTemplates = new Map();
    this.hasLoaded = false;
  }

  /** Cache key for a tinted template, e.g. "wq" for a white queen. */
  static templateKey(pieceType, pieceColour) {
    return `${pieceColour}${pieceType}`;
  }

  /**
   * Draw one top-icon disc as a 2D canvas, ready to become a texture.
   *
   * Black pieces get the drawing rotated 180° before the glyph is stamped on.
   * `buildTintedTemplates` rotates the whole black template around Y so its
   * knight faces the right way (see the comment there); without this
   * counter-rotation the icon would come along for that spin and read
   * upside-down when the board is viewed from above.
   */
  static createTopIconCanvas(pieceType, pieceColour) {
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
    context.lineWidth = 5;
    context.strokeStyle = inkColour;
    context.stroke();

    if (pieceColour === 'b') {
      context.translate(64, 64);
      context.rotate(Math.PI);
      context.translate(-64, -64);
    }

    context.fillStyle = inkColour;
    context.font = '80px "Segoe UI Symbol", "DejaVu Sans", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(PIECE_TOP_ICON_GLYPHS[pieceType], 64, 68);

    return canvas;
  }

  /** Build the flat, upward-facing disc that sits on top of one piece. */
  createTopIconMesh(pieceType, pieceColour, pieceHeight) {
    const THREE = this.THREE;
    const canvas = PieceLoader.createTopIconCanvas(pieceType, pieceColour);
    const texture = new THREE.CanvasTexture(canvas);

    const iconMesh = new THREE.Mesh(
      new THREE.CircleGeometry(TOP_ICON_DIAMETER / 2, 24),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: true })
    );
    iconMesh.name = 'topIcon';
    // A circle's default normal is +Z; tip it flat so it faces +Y (straight
    // up), which is the way the player is looking in marker-based AR.
    iconMesh.rotation.x = -Math.PI / 2;
    iconMesh.position.y = pieceHeight + TOP_ICON_CLEARANCE;
    return iconMesh;
  }

  /**
   * Download and prepare every piece.
   *
   * All six downloads run in parallel because they are independent and each
   * file is only tens of kilobytes; loading them one after another would add
   * six round trips of latency for no benefit.
   *
   * @param {(loadedCount: number, totalCount: number) => void} [onProgress]
   *   Called as each model arrives, so a page can show a real loading bar.
   */
  async loadAllPieces(onProgress) {
    if (this.hasLoaded) {
      return;
    }

    const pieceTypes = Object.keys(PIECE_MODEL_FILES);
    let loadedCount = 0;

    await Promise.all(
      pieceTypes.map(async (pieceType) => {
        const modelUrl = this.basePath + PIECE_MODEL_FILES[pieceType];
        const loadedGltf = await this.gltfLoader.loadAsync(modelUrl);
        this.loadedModelsByType.set(pieceType, loadedGltf.scene);

        loadedCount += 1;
        if (onProgress) {
          onProgress(loadedCount, pieceTypes.length);
        }
      })
    );

    this.buildTintedTemplates();
    this.hasLoaded = true;
  }

  /**
   * Turn each loaded model into one ivory and one charcoal template.
   *
   * The exported models carry an ivory base colour, so tinting overwrites the
   * material colour outright rather than multiplying into it — that keeps the
   * charcoal side genuinely dark instead of a muddy beige.
   */
  buildTintedTemplates() {
    for (const [pieceType, loadedScene] of this.loadedModelsByType) {
      // Measured once per piece type, before any per-colour clone or rotation,
      // so the icon sits at the same height on both a white and a black piece
      // of the same type. Skipped entirely when there is no icon to place.
      const pieceHeight = this.showTopIcons
        ? new this.THREE.Box3().setFromObject(loadedScene).max.y
        : 0;

      for (const pieceColour of Object.keys(PIECE_COLOURS)) {
        const tintedTemplate = loadedScene.clone(true);

        tintedTemplate.traverse((sceneChild) => {
          if (!sceneChild.isMesh) {
            return;
          }
          // `clone()` shares materials with the original, so a fresh material
          // is essential here — without it, tinting one colour would silently
          // repaint the other one too.
          sceneChild.material = sceneChild.material.clone();
          sceneChild.material.color.setHex(PIECE_COLOURS[pieceColour]);
          sceneChild.castShadow = true;
          sceneChild.receiveShadow = false;
        });

        // Black pieces face down the board so the knight — the only piece with
        // a front — looks at its opponent rather than away from it.
        if (pieceColour === 'b') {
          tintedTemplate.rotation.y = Math.PI;
        }

        if (this.showTopIcons) {
          tintedTemplate.add(this.createTopIconMesh(pieceType, pieceColour, pieceHeight));
        }

        this.tintedTemplates.set(PieceLoader.templateKey(pieceType, pieceColour), tintedTemplate);
      }
    }
  }

  /**
   * A ready-to-position piece.
   *
   * @param {string} pieceType   chess.js letter: p r n b q k
   * @param {string} pieceColour chess.js colour: 'w' or 'b'
   * @returns {object} A Three.js object whose origin is the centre of the
   *   piece's base, so positioning it on a square is a single `position.set`.
   */
  createPiece(pieceType, pieceColour) {
    const template = this.tintedTemplates.get(PieceLoader.templateKey(pieceType, pieceColour));
    if (!template) {
      throw new Error(`[piece-loader] no model for piece "${pieceColour}${pieceType}"`);
    }

    const pieceObject = template.clone(true);
    pieceObject.name = `piece_${pieceColour}${pieceType}`;
    // Read back by the raycaster and the move animation.
    pieceObject.userData.pieceType = pieceType;
    pieceObject.userData.pieceColour = pieceColour;
    return pieceObject;
  }
}
