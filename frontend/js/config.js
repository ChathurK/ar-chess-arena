/**
 * config.js
 * =========
 * Every value that is shared between the two AR modes, or that a person
 * deploying this project might need to change, lives here. Nothing in this
 * file has any behaviour, so it is safe to read top-to-bottom as a reference.
 */

/* ------------------------------------------------------------------------ *
 * Backend
 * ------------------------------------------------------------------------ */

/**
 * The Socket.IO relay that Duel Mode connects to.
 *
 * Resolution order, most specific first:
 *   1. a `?server=` query parameter  — handy when testing a branch deployment
 *      or a tunnelled local backend from a phone,
 *   2. localhost                     — when the page itself is served locally,
 *   3. the deployed Render service   — everything else, including the
 *      Cloudflare-tunnelled URLs used for phone testing.
 *
 * ▸ DEPLOYMENT STEP: replace DEPLOYED_SOCKET_SERVER_URL with the real Render
 *   URL once the backend is live. Everything else adapts automatically.
 */
const DEPLOYED_SOCKET_SERVER_URL = 'https://ar-chess-arena.onrender.com';
const LOCAL_SOCKET_SERVER_URL = 'http://localhost:3000';
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

function resolveSocketServerUrl() {
  const overrideFromQueryString = new URLSearchParams(window.location.search).get('server');
  if (overrideFromQueryString) {
    return overrideFromQueryString;
  }
  if (LOCAL_HOSTNAMES.includes(window.location.hostname)) {
    return LOCAL_SOCKET_SERVER_URL;
  }
  return DEPLOYED_SOCKET_SERVER_URL;
}

export const SOCKET_SERVER_URL = resolveSocketServerUrl();

/* ------------------------------------------------------------------------ *
 * Third-party libraries (pinned — never use @latest, it breaks reproducibility)
 * ------------------------------------------------------------------------ */

/** chess.js ships a pre-bundled ES module with no bare imports of its own. */
export const CHESS_JS_MODULE_URL = 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/dist/esm/chess.js';

/* ------------------------------------------------------------------------ *
 * 3D models
 * ------------------------------------------------------------------------ */

export const MODEL_BASE_PATH = './assets/models/';

/**
 * Maps a chess.js piece letter to its generated model file. Only six files
 * exist because colour is applied at runtime as a material tint rather than
 * being baked into twelve separate models.
 */
export const PIECE_MODEL_FILES = {
  p: 'pawn.glb',
  r: 'rook.glb',
  n: 'knight.glb',
  b: 'bishop.glb',
  q: 'queen.glb',
  k: 'king.glb',
};

/* ------------------------------------------------------------------------ *
 * Board geometry
 * ------------------------------------------------------------------------ */

/**
 * The board is authored in "board units" where one unit is exactly one
 * square. Each scene then scales the whole board group once, so the same
 * geometry serves a small marker-sized board and a larger room-scale one.
 */
export const BOARD_GEOMETRY = {
  SQUARE_SIZE: 1.0,
  SQUARES_PER_SIDE: 8,
  TILE_THICKNESS: 0.08,
  /** How far the wooden frame extends past the playing surface. */
  FRAME_MARGIN: 0.35,
  FRAME_THICKNESS: 0.1,
};

/** Board scale for each mode, chosen so the board reads well at arm's length. */
export const BOARD_SCALE = {
  /** Marker mode: 1.28 marker-widths across, which frames the marker nicely. */
  PUZZLE: 0.16,
  /** Duel mode: metres. 0.045 x 8 squares gives a 36 cm board on the floor. */
  DUEL_DEFAULT: 0.045,
  DUEL_MINIMUM: 0.025,
  DUEL_MAXIMUM: 0.09,
};

/* ------------------------------------------------------------------------ *
 * Colours
 * ------------------------------------------------------------------------ */

export const BOARD_COLOURS = {
  LIGHT_SQUARE: 0xe8dcc0,
  DARK_SQUARE: 0x6b4f3a,
  FRAME: 0x4a3627,
};

export const PIECE_COLOURS = {
  /** chess.js uses 'w' and 'b' for the two sides, so the keys match it. */
  w: 0xf2ead8,
  b: 0x2f3336,
};

/**
 * Square highlight colours. These are applied by replacing a tile's material
 * colour, so they must stay readable against both the light and dark squares.
 */
export const HIGHLIGHT_COLOURS = {
  SELECTED: 0xf0c419,
  LEGAL_MOVE: 0x4caf50,
  CAPTURE_TARGET: 0xe05c4a,
  LAST_MOVE: 0x3f7fa8,
  KING_IN_CHECK: 0xd32f2f,
};

/* ------------------------------------------------------------------------ *
 * Timing
 * ------------------------------------------------------------------------ */

export const ANIMATION = {
  /** Milliseconds a piece takes to slide from one square to another. */
  MOVE_DURATION_MS: 320,
  /** How high a moving piece arcs, in board units. */
  MOVE_ARC_HEIGHT: 0.45,
  /** Milliseconds a captured piece takes to shrink away. */
  CAPTURE_DURATION_MS: 220,
};
