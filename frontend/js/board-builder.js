/**
 * board-builder.js
 * ================
 * Builds the 8×8 board as plain Three.js geometry, and owns the mapping
 * between algebraic squares ("e4") and 3D positions.
 *
 * WHY THE BOARD IS PROCEDURAL AND NOT AN IMPORTED MODEL
 * ----------------------------------------------------
 * Every square needs to be highlighted independently (selection, legal moves,
 * capture targets, the last move played, a king in check). That means 64
 * separately-addressable meshes with their own materials — which an imported
 * single-mesh model could not give us, and which is trivial to generate.
 *
 * WHY `THREE` IS PASSED IN RATHER THAN IMPORTED
 * ---------------------------------------------
 * Duel Mode imports Three.js directly; Puzzle Mode runs inside A-Frame, which
 * bundles its own copy of Three.js. Mixing objects from two different Three.js
 * builds in one scene causes subtle, hard-to-debug breakage, so every function
 * here takes the caller's `THREE` namespace instead of importing one.
 *
 * COORDINATE CONVENTION (everything else depends on this)
 * -------------------------------------------------------
 *   • one board unit  = one square,
 *   • the board is centred on the origin and spans −4 … +4 on X and Z,
 *   • files a…h run left to right along +X,
 *   • ranks 1…8 run from +Z towards −Z, so a camera sitting at +Z looks at the
 *     board from White's side, which is the natural default,
 *   • the playing surface is exactly y = 0, so a piece is placed by setting
 *     its position to (x, 0, z).
 */

import { BOARD_GEOMETRY, BOARD_COLOURS } from './config.js';

export const FILE_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
export const RANK_NUMBERS = ['1', '2', '3', '4', '5', '6', '7', '8'];

/* ------------------------------------------------------------------------ *
 * Square ⇄ position mapping
 * ------------------------------------------------------------------------ */

/**
 * Split an algebraic square into zero-based indices.
 * @returns {{fileIndex: number, rankIndex: number} | null}
 */
export function squareToIndices(square) {
  if (typeof square !== 'string' || square.length !== 2) {
    return null;
  }
  const fileIndex = FILE_LETTERS.indexOf(square[0]);
  const rankIndex = RANK_NUMBERS.indexOf(square[1]);
  if (fileIndex === -1 || rankIndex === -1) {
    return null;
  }
  return { fileIndex, rankIndex };
}

/** Build an algebraic square from zero-based indices, or null if off-board. */
export function indicesToSquare(fileIndex, rankIndex) {
  if (fileIndex < 0 || fileIndex > 7 || rankIndex < 0 || rankIndex > 7) {
    return null;
  }
  return FILE_LETTERS[fileIndex] + RANK_NUMBERS[rankIndex];
}

/**
 * The centre of a square, in board-local coordinates.
 * @returns {{x: number, y: number, z: number} | null}
 */
export function squareToLocalPosition(square) {
  const indices = squareToIndices(square);
  if (!indices) {
    return null;
  }
  const { SQUARE_SIZE, SQUARES_PER_SIDE } = BOARD_GEOMETRY;
  const centreOffset = (SQUARES_PER_SIDE - 1) / 2; // 3.5 for a standard board
  return {
    x: (indices.fileIndex - centreOffset) * SQUARE_SIZE,
    y: 0,
    z: (centreOffset - indices.rankIndex) * SQUARE_SIZE,
  };
}

/**
 * The inverse of `squareToLocalPosition`: which square (if any) sits under a
 * given board-local (x, z) point.
 *
 * Used as a raycast fallback — a tap that misses every mesh (a thin piece
 * model, or the gap around one) but still lands within the board's footprint
 * should still register, rather than silently doing nothing.
 * @returns {string|null}
 */
export function localPositionToSquare(x, z) {
  const { SQUARE_SIZE, SQUARES_PER_SIDE } = BOARD_GEOMETRY;
  const centreOffset = (SQUARES_PER_SIDE - 1) / 2;
  const fileIndex = Math.round(x / SQUARE_SIZE + centreOffset);
  const rankIndex = Math.round(centreOffset - z / SQUARE_SIZE);
  return indicesToSquare(fileIndex, rankIndex);
}

/** A light square is one where the file and rank indices differ in parity. */
export function isLightSquare(square) {
  const indices = squareToIndices(square);
  return indices !== null && (indices.fileIndex + indices.rankIndex) % 2 === 1;
}

/** Every square on the board, in a stable a1 … h8 order. */
export function listAllSquares() {
  const allSquares = [];
  for (const rankNumber of RANK_NUMBERS) {
    for (const fileLetter of FILE_LETTERS) {
      allSquares.push(fileLetter + rankNumber);
    }
  }
  return allSquares;
}

/* ------------------------------------------------------------------------ *
 * Board construction
 * ------------------------------------------------------------------------ */

/**
 * Build the board.
 *
 * @param {object} THREE The caller's Three.js namespace (see the note above).
 * @returns {{group: object, tilesBySquare: Map<string, object>}}
 *   `group` is ready to be added to any scene; `tilesBySquare` gives each
 *   square's mesh so highlights can be applied without searching the scene.
 */
export function createBoard(THREE) {
  const { SQUARE_SIZE, SQUARES_PER_SIDE, TILE_THICKNESS, FRAME_MARGIN, FRAME_THICKNESS } =
    BOARD_GEOMETRY;

  const boardGroup = new THREE.Group();
  boardGroup.name = 'chessBoard';

  // --- Frame -------------------------------------------------------------
  // A single slab underneath the tiles, slightly wider than the playing
  // surface, which reads as a wooden border without any extra geometry.
  const playingSurfaceWidth = SQUARES_PER_SIDE * SQUARE_SIZE;
  const frameWidth = playingSurfaceWidth + FRAME_MARGIN * 2;
  const frameMesh = new THREE.Mesh(
    new THREE.BoxGeometry(frameWidth, FRAME_THICKNESS, frameWidth),
    new THREE.MeshStandardMaterial({
      color: BOARD_COLOURS.FRAME,
      roughness: 0.75,
      metalness: 0.0,
    })
  );
  // Sit the frame directly beneath the tiles so their top faces stay at y = 0.
  frameMesh.position.y = -TILE_THICKNESS - FRAME_THICKNESS / 2;
  frameMesh.name = 'boardFrame';
  frameMesh.receiveShadow = true;
  boardGroup.add(frameMesh);

  // --- Tiles -------------------------------------------------------------
  // One shared geometry, but a material per tile: highlighting works by
  // changing a tile's own material colour, so materials cannot be shared.
  const sharedTileGeometry = new THREE.BoxGeometry(SQUARE_SIZE, TILE_THICKNESS, SQUARE_SIZE);
  const tilesBySquare = new Map();

  for (const square of listAllSquares()) {
    const baseColour = isLightSquare(square)
      ? BOARD_COLOURS.LIGHT_SQUARE
      : BOARD_COLOURS.DARK_SQUARE;

    const tileMesh = new THREE.Mesh(
      sharedTileGeometry,
      new THREE.MeshStandardMaterial({ color: baseColour, roughness: 0.65, metalness: 0.0 })
    );

    const localPosition = squareToLocalPosition(square);
    tileMesh.position.set(localPosition.x, -TILE_THICKNESS / 2, localPosition.z);
    tileMesh.name = `tile_${square}`;
    tileMesh.receiveShadow = true;

    // Consulted by the raycaster when the user taps, and by the highlight
    // code when a tile has to be restored to its normal colour.
    tileMesh.userData.square = square;
    tileMesh.userData.baseColour = baseColour;

    boardGroup.add(tileMesh);
    tilesBySquare.set(square, tileMesh);
  }

  return { group: boardGroup, tilesBySquare };
}

/* ------------------------------------------------------------------------ *
 * Highlighting
 * ------------------------------------------------------------------------ */

/**
 * Paint a tile with a highlight colour, or pass null to restore its normal
 * light/dark colour.
 */
export function setTileHighlight(tileMesh, highlightColour) {
  if (!tileMesh) {
    return;
  }
  tileMesh.material.color.setHex(
    highlightColour === null || highlightColour === undefined
      ? tileMesh.userData.baseColour
      : highlightColour
  );
}

/** Restore every tile to its normal colour in one call. */
export function clearAllHighlights(tilesBySquare) {
  for (const tileMesh of tilesBySquare.values()) {
    setTileHighlight(tileMesh, null);
  }
}

/* ------------------------------------------------------------------------ *
 * Lighting
 * ------------------------------------------------------------------------ */

/**
 * Lighting suitable for an AR scene, returned as a group so a caller can add
 * or remove it in one operation.
 *
 * AR camera feeds are already bright, so the mix is deliberately gentle: a
 * hemisphere light supplies soft ambient fill that keeps the dark pieces from
 * going to solid black, and one directional light gives enough shading for the
 * turned shapes of the pieces to read as three-dimensional.
 */
export function createSceneLighting(THREE) {
  const lightingGroup = new THREE.Group();
  lightingGroup.name = 'sceneLighting';

  const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0xbbbbaa, 1.1);
  hemisphereLight.position.set(0, 6, 0);
  lightingGroup.add(hemisphereLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.4);
  directionalLight.position.set(3, 8, 4);
  lightingGroup.add(directionalLight);

  return lightingGroup;
}
