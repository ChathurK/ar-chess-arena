/**
 * piece-loader.js
 * ===============
 * Loads the six generated .glb piece models once, tints them into the twelve
 * pieces a chess set actually needs, and hands out cheap clones on demand.
 *
 * WHY SIX FILES BECOME TWELVE PIECES
 * ----------------------------------
 * Each piece is exported in a neutral ivory. Colour is a material property,
 * not geometry, so tinting at runtime halves the number of files the phone has
 * to download over what is often a mobile connection.
 *
 * TWO TONES PER PIECE
 * -------------------
 * A model may be built from more than one material: the imported set produced
 * by scripts/extract_chess_pieces.py splits every piece into a "body" mesh and
 * an "accent" mesh, so the metal rings and finials can be tinted separately
 * from the turned wood. The generated set in assets/models/ is a single
 * unnamed mesh per piece with no accent at all.
 *
 * Both work here, and that is deliberate: anything not identifiable as an
 * accent is treated as body, so a model with no accent simply comes out one
 * colour. Switching between the two sets stays a MODEL_BASE_PATH change in
 * config.js and nothing more.
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
   */
  constructor({ THREE, GLTFLoader, basePath = MODEL_BASE_PATH }) {
    this.THREE = THREE;
    this.basePath = basePath;
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
   * Is this mesh a piece's metallic accent rather than its body?
   *
   * Both the mesh name and the material name are checked, because they come
   * from different places in the glTF and either one can be the survivor. The
   * extraction script writes a node called "accent" AND a material called
   * "ChessPieceAccent"; a model exported by other tooling, or run through a
   * glTF optimiser that renames or drops nodes, may keep only one of them.
   *
   * Anything unrecognised is body. That is what lets the single-mesh generated
   * set work through this same code path without a special case.
   */
  static isAccentMesh(mesh) {
    const meshName = (mesh.name || '').toLowerCase();
    const materialName = ((mesh.material && mesh.material.name) || '').toLowerCase();
    return meshName.includes('accent') || materialName.includes('accent');
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
   * Turn each loaded model into one light-side and one dark-side template.
   *
   * The models carry a neutral base colour, so tinting overwrites the material
   * colour outright rather than multiplying into it — that keeps the dark side
   * genuinely dark instead of a muddy beige.
   *
   * Only the colour is touched. Metalness and roughness are left exactly as the
   * model authored them, which is what makes a tinted accent still read as
   * metal rather than as painted wood.
   */
  buildTintedTemplates() {
    for (const [pieceType, loadedScene] of this.loadedModelsByType) {
      // Measured once per piece type, before any per-colour clone or rotation,
      // so the icon sits at the same height on both a white and a black piece
      // of the same type.
      const pieceHeight = new this.THREE.Box3().setFromObject(loadedScene).max.y;

      for (const pieceColour of Object.keys(PIECE_COLOURS)) {
        const palette = PIECE_COLOURS[pieceColour];
        // Without this, an older single-hex PIECE_COLOURS would make every
        // lookup undefined and setHex would quietly paint the whole set black,
        // which is a genuinely confusing thing to debug from a phone.
        if (
          typeof palette !== 'object' ||
          typeof palette.body !== 'number' ||
          typeof palette.accent !== 'number'
        ) {
          throw new Error(
            `[piece-loader] PIECE_COLOURS.${pieceColour} must be an object with ` +
              'numeric body and accent colours — see config.js'
          );
        }

        const tintedTemplate = loadedScene.clone(true);

        tintedTemplate.traverse((sceneChild) => {
          if (!sceneChild.isMesh) {
            return;
          }
          // Decided before the material is replaced, because the material's
          // own name is one of the two signals it reads.
          const tint = PieceLoader.isAccentMesh(sceneChild) ? palette.accent : palette.body;

          // `clone()` shares materials with the original, so a fresh material
          // is essential here — without it, tinting one colour would silently
          // repaint the other one too.
          sceneChild.material = sceneChild.material.clone();
          sceneChild.material.color.setHex(tint);
          sceneChild.castShadow = true;
          sceneChild.receiveShadow = false;
        });

        // Black pieces face down the board so the knight — the only piece with
        // a front — looks at its opponent rather than away from it.
        if (pieceColour === 'b') {
          tintedTemplate.rotation.y = Math.PI;
        }

        tintedTemplate.add(this.createTopIconMesh(pieceType, pieceColour, pieceHeight));

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
