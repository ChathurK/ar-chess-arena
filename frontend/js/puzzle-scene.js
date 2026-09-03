/**
 * puzzle-scene.js
 * ===============
 * Puzzle Mode: the MARKER-BASED version.
 *
 * HOW MARKER TRACKING WORKS HERE
 * ------------------------------
 * AR.js watches the camera feed for the Hiro pattern and, when it finds it,
 * continuously updates the transform of the `<a-marker>` entity so that it
 * matches the marker's real-world position and orientation. Anything parented
 * to that entity therefore appears to stand on the printed marker. All this
 * module does is attach the board to it — the tracking itself is AR.js's job.
 *
 * WHY THE BOARD IS RAW THREE.JS INSIDE AN A-FRAME PAGE
 * ----------------------------------------------------
 * The board, the pieces and the move animations are shared with Duel Mode,
 * which is a plain Three.js/WebXR application. Rather than maintaining an
 * A-Frame version and a Three.js version of the same board, the shared modules
 * build a plain Three.js object and this file hangs it off the marker entity
 * with `setObject3D`. A-Frame is itself a wrapper over Three.js, so the object
 * is a first-class citizen of the scene graph — the one rule is that it must
 * be built with A-FRAME'S copy of Three.js (`AFRAME.THREE`), never a second
 * imported one, which is why `THREE` is passed into every shared module.
 *
 * GAME RULES IN THIS MODE
 * -----------------------
 * The player is always White and must deliver checkmate within the puzzle's
 * move budget. Black replies with a legal move — any legal move, because every
 * position here has been proved a forced mate, so no defence can save it.
 */

import { ChessEngine } from './chess-engine.js';
import { PieceLoader } from './piece-loader.js';
import { BoardView } from './board-view.js';
import { createSceneLighting } from './board-builder.js';
import { PUZZLES } from './puzzles.js';
import { BOARD_SCALE } from './config.js';
import { gameAudio } from './audio.js';

/**
 * How far the board is tipped back around the X axis, in degrees.
 *
 * Marker-based AR is usually viewed from close to directly above the board,
 * which foreshortens the real 3D piece models down to their crowns — a
 * bishop and a pawn silhouette almost the same from straight overhead. A
 * small permanent tilt keeps the board readable as a marker (still close to
 * flat) while opening the pieces up enough that their shapes stay
 * distinguishable no matter the angle the phone happens to be held at.
 */
const BOARD_TILT_DEGREES = 18;

/* ------------------------------------------------------------------------ *
 * Page elements
 * ------------------------------------------------------------------------ */

const pageElements = {
  scene: document.querySelector('a-scene'),
  marker: document.getElementById('chessMarker'),
  overlay: document.getElementById('arOverlay'),
  title: document.getElementById('puzzleTitle'),
  movesBadge: document.getElementById('movesBadge'),
  stateBadge: document.getElementById('stateBadge'),
  statusMessage: document.getElementById('statusMessage'),
  hintButton: document.getElementById('hintButton'),
  retryButton: document.getElementById('retryButton'),
  nextButton: document.getElementById('nextButton'),
  soundButton: document.getElementById('soundButton'),
  toast: document.getElementById('toast'),
  loadingCurtain: document.getElementById('loadingCurtain'),
  loadingText: document.getElementById('loadingText'),
  progressFill: document.getElementById('progressFill'),
  startButton: document.getElementById('startButton'),
};

/* ------------------------------------------------------------------------ *
 * Mutable state — everything the scene needs to remember between taps
 * ------------------------------------------------------------------------ */

const puzzleSession = {
  /** 'loading' | 'awaiting-marker' | 'player-turn' | 'black-replying' | 'solved' | 'failed' */
  phase: 'loading',
  puzzleIndex: 0,
  chessEngine: null,
  boardView: null,
  pieceLoader: null,
  /** White moves played in this attempt, counted against the puzzle's budget. */
  playerMovesUsed: 0,
  selectedSquare: null,
  legalTargetsFromSelection: [],
  isMarkerVisible: false,
};

/** The puzzle currently being played. */
function currentPuzzle() {
  return PUZZLES[puzzleSession.puzzleIndex];
}

/* ------------------------------------------------------------------------ *
 * Interface helpers
 * ------------------------------------------------------------------------ */

let toastTimeoutId = null;

/** Show a short message over the board, then fade it out. */
function showToast(message, variant = 'default', durationMs = 2200) {
  pageElements.toast.textContent = message;
  pageElements.toast.className = 'toast toast--visible';
  if (variant === 'danger') {
    pageElements.toast.classList.add('toast--danger');
  } else if (variant === 'success') {
    pageElements.toast.classList.add('toast--success');
  }

  window.clearTimeout(toastTimeoutId);
  toastTimeoutId = window.setTimeout(() => {
    pageElements.toast.classList.remove('toast--visible');
  }, durationMs);
}

/** Repaint the whole status panel from the current session state. */
function refreshStatusPanel() {
  const puzzle = currentPuzzle();
  pageElements.title.textContent = puzzle.name;
  pageElements.movesBadge.textContent = `${puzzleSession.playerMovesUsed} / ${puzzle.moveBudget} moves`;

  const badgeStates = {
    loading: ['Starting', ''],
    'awaiting-marker': ['Find marker', 'status-badge--warn'],
    'player-turn': ['Your move', 'status-badge--live'],
    'black-replying': ['Black thinking', ''],
    solved: ['Solved', 'status-badge--live'],
    failed: ['Failed', 'status-badge--danger'],
  };
  const [badgeLabel, badgeModifier] = badgeStates[puzzleSession.phase] || ['—', ''];
  pageElements.stateBadge.textContent = badgeLabel;
  pageElements.stateBadge.className = `status-badge ${badgeModifier}`.trim();
}

/** Replace the explanatory line under the title. */
function setStatusMessage(htmlMessage) {
  pageElements.statusMessage.innerHTML = htmlMessage;
}

/* ------------------------------------------------------------------------ *
 * Start-up
 * ------------------------------------------------------------------------ */

/** Resolve once A-Frame has finished building the scene. */
function waitForSceneToLoad(sceneElement) {
  return new Promise((resolve) => {
    if (sceneElement.hasLoaded) {
      resolve();
    } else {
      sceneElement.addEventListener('loaded', () => resolve(), { once: true });
    }
  });
}

/**
 * An A-Frame component whose only job is to drive the shared board's
 * animations from A-Frame's own render loop.
 *
 * Using A-Frame's `tick` rather than a separate requestAnimationFrame matters:
 * it guarantees piece positions are updated in the same frame they are drawn,
 * so a moving piece can never be rendered one frame behind the rest of the
 * scene.
 */
AFRAME.registerComponent('chess-animation-driver', {
  tick(totalTime, timeSinceLastFrame) {
    if (puzzleSession.boardView) {
      // Clamped so that a tab returning from the background does not deliver
      // one enormous delta and fast-forward a piece through its animation.
      puzzleSession.boardView.update(Math.min(100, timeSinceLastFrame));
    }
  },
});

async function initialisePuzzleMode() {
  await waitForSceneToLoad(pageElements.scene);

  // A-Frame bundles its own Three.js build. Using this exact namespace —
  // rather than importing Three.js again — is what keeps the shared modules
  // compatible with the A-Frame scene graph. Its GLTFLoader is pulled from
  // the same namespace for the same reason: mixing objects built by two
  // different Three.js instances in one scene graph is what the shared
  // loaders are explicitly written to avoid.
  const THREE = AFRAME.THREE;
  const GLTFLoader = THREE.GLTFLoader;

  puzzleSession.pieceLoader = new PieceLoader({ THREE, GLTFLoader });

  try {
    await puzzleSession.pieceLoader.loadAllPieces((loadedCount, totalCount) => {
      pageElements.progressFill.style.width = `${(loadedCount / totalCount) * 100}%`;
      pageElements.loadingText.textContent = `Preparing pieces… ${loadedCount} of ${totalCount}`;
    });
  } catch (loadError) {
    console.error('[puzzle] failed to load piece models:', loadError);
    pageElements.loadingText.textContent = 'Could not load the 3D pieces. Check that assets/models/ was deployed.';
    return;
  }

  puzzleSession.boardView = new BoardView({ THREE, pieceLoader: puzzleSession.pieceLoader });
  puzzleSession.boardView.object3D.scale.setScalar(BOARD_SCALE.PUZZLE);
  // Tip the whole board+pieces group back a few degrees so the 3D pieces
  // read as shapes rather than flat tops when viewed close to overhead.
  puzzleSession.boardView.object3D.rotation.x = -THREE.MathUtils.degToRad(BOARD_TILT_DEGREES);
  // Attach the board to the marker: from here on AR.js positions it for us.
  pageElements.marker.setObject3D('chessboard', puzzleSession.boardView.object3D);

  // Lighting belongs to the scene rather than the marker, so the board stays
  // lit consistently no matter which way the marker is facing.
  pageElements.scene.object3D.add(createSceneLighting(THREE));
  pageElements.scene.setAttribute('chess-animation-driver', '');

  wireUpMarkerEvents();
  wireUpControls();
  loadPuzzle(0);

  pageElements.loadingText.textContent = 'Ready.';
  pageElements.startButton.disabled = false;
}

/* ------------------------------------------------------------------------ *
 * Marker tracking
 * ------------------------------------------------------------------------ */

/**
 * How long a `markerLost` event has to keep holding true before the board is
 * actually treated as gone.
 *
 * AR.js's own detector can drop and re-find the marker within a single frame
 * under normal handshake — a slightly shaky hand, a moment of motion blur —
 * which is what the visible "blink" is. Without this delay, every one of
 * those blinks also disabled tapping for that instant, which is a very
 * plausible reason a tap can appear to do nothing at all.
 */
const MARKER_LOST_GRACE_MS = 250;
let markerLostTimeoutId = null;

function wireUpMarkerEvents() {
  pageElements.marker.addEventListener('markerFound', () => {
    window.clearTimeout(markerLostTimeoutId);
    puzzleSession.isMarkerVisible = true;
    if (puzzleSession.phase === 'awaiting-marker') {
      puzzleSession.phase = 'player-turn';
      describeCurrentTask();
    }
    refreshStatusPanel();
  });

  pageElements.marker.addEventListener('markerLost', () => {
    window.clearTimeout(markerLostTimeoutId);
    markerLostTimeoutId = window.setTimeout(() => {
      puzzleSession.isMarkerVisible = false;
      // The position is not lost — only the view of it — so the phase is kept
      // and simply reported differently. Walking around the marker mid-puzzle
      // should never reset progress.
      setStatusMessage('Marker lost. Point the camera back at it to carry on.');
    }, MARKER_LOST_GRACE_MS);
  });
}

/* ------------------------------------------------------------------------ *
 * Puzzle lifecycle
 * ------------------------------------------------------------------------ */

/** Load a puzzle by index and reset everything about the current attempt. */
function loadPuzzle(puzzleIndex) {
  puzzleSession.puzzleIndex = ((puzzleIndex % PUZZLES.length) + PUZZLES.length) % PUZZLES.length;
  const puzzle = currentPuzzle();

  puzzleSession.chessEngine = new ChessEngine(puzzle.fen);
  puzzleSession.playerMovesUsed = 0;
  puzzleSession.selectedSquare = null;
  puzzleSession.legalTargetsFromSelection = [];

  puzzleSession.boardView.rebuildFromEngine(puzzleSession.chessEngine);
  puzzleSession.boardView.setSelection(null);
  puzzleSession.boardView.setLastMove(null, null);
  puzzleSession.boardView.setCheckedKing(null);

  puzzleSession.phase = puzzleSession.isMarkerVisible ? 'player-turn' : 'awaiting-marker';
  describeCurrentTask();
  refreshStatusPanel();
}

/** Write the "what should I do now" line for the current phase. */
function describeCurrentTask() {
  const puzzle = currentPuzzle();
  if (puzzleSession.phase === 'awaiting-marker') {
    setStatusMessage('Point your camera at the <strong>Hiro marker</strong> to place the board.');
    return;
  }
  if (puzzleSession.phase === 'player-turn') {
    setStatusMessage(
      `You are <strong>White</strong>. Force checkmate in <strong>${puzzle.moveBudget}</strong> ` +
        'moves. Tap a piece, then tap where it should go.'
    );
  }
}

/* ------------------------------------------------------------------------ *
 * Playing
 * ------------------------------------------------------------------------ */

/**
 * The single entry point for every tap that lands on the board.
 *
 * Selection follows the convention every chess app uses, because it is what
 * people already expect: tap your own piece to pick it up, tap a highlighted
 * square to move there, tap a different piece of yours to change your mind,
 * tap anywhere else to put the piece down.
 */
function handleSquareTapped(square) {
  if (puzzleSession.phase !== 'player-turn' || puzzleSession.boardView.isAnimating) {
    return;
  }

  const engine = puzzleSession.chessEngine;
  const boardView = puzzleSession.boardView;

  if (puzzleSession.selectedSquare) {
    if (square === puzzleSession.selectedSquare) {
      clearSelection();
      return;
    }
    const chosenTarget = puzzleSession.legalTargetsFromSelection.find(
      (target) => target.to === square
    );
    if (chosenTarget) {
      playPlayerMove(puzzleSession.selectedSquare, square);
      return;
    }
    if (engine.isSquareOccupiedBy(square, 'w')) {
      selectSquare(square);
      return;
    }
    gameAudio.playRejected();
    clearSelection();
    return;
  }

  if (engine.isSquareOccupiedBy(square, 'w')) {
    selectSquare(square);
  } else if (engine.getPieceAt(square)) {
    showToast('You are playing White.', 'danger', 1400);
    gameAudio.playRejected();
  }
}

function selectSquare(square) {
  const legalTargets = puzzleSession.chessEngine.listLegalDestinations(square);
  puzzleSession.selectedSquare = square;
  puzzleSession.legalTargetsFromSelection = legalTargets;
  puzzleSession.boardView.setSelection(square, legalTargets);

  if (legalTargets.length === 0) {
    showToast('That piece has no legal moves.', 'danger', 1400);
    gameAudio.playRejected();
  } else {
    gameAudio.playSelect();
  }
}

function clearSelection() {
  puzzleSession.selectedSquare = null;
  puzzleSession.legalTargetsFromSelection = [];
  puzzleSession.boardView.setSelection(null);
}

/** Apply the player's move, then decide whether the puzzle is over. */
function playPlayerMove(fromSquare, toSquare) {
  const engine = puzzleSession.chessEngine;
  const result = engine.applyMove(fromSquare, toSquare);
  if (!result.ok) {
    gameAudio.playRejected();
    showToast('That move is not legal.', 'danger', 1500);
    clearSelection();
    return;
  }

  puzzleSession.playerMovesUsed += 1;
  clearSelection();
  animateAndSound(result.move, result.status);
  refreshStatusPanel();

  if (result.status.isCheckmate) {
    finishPuzzleAsSolved();
    return;
  }
  if (result.status.isGameOver) {
    finishPuzzleAsFailed('That ended the game without checkmate — it is a draw.');
    return;
  }
  if (puzzleSession.playerMovesUsed >= currentPuzzle().moveBudget) {
    finishPuzzleAsFailed('Out of moves. This position is mate — there is a faster way.');
    return;
  }

  // Black defends. Every one of these positions is a proved forced mate, so
  // any legal reply is a losing one; a short delay makes the exchange read as
  // a reply rather than a glitch.
  puzzleSession.phase = 'black-replying';
  refreshStatusPanel();
  window.setTimeout(playBlackReply, 700);
}

/** Black plays a random legal move — every defence loses, so none is better. */
function playBlackReply() {
  const engine = puzzleSession.chessEngine;

  const allBlackMoves = [];
  for (const occupied of engine.listOccupiedSquares()) {
    if (occupied.colour !== 'b') {
      continue;
    }
    for (const destination of engine.listLegalDestinations(occupied.square)) {
      allBlackMoves.push({ from: occupied.square, to: destination.to });
    }
  }

  if (allBlackMoves.length === 0) {
    // Black is mated or stalemated; the check above will already have caught
    // mate, so this can only be a stalemate the player walked into.
    finishPuzzleAsFailed('Stalemate — Black has no legal move but is not in check.');
    return;
  }

  const chosenMove = allBlackMoves[Math.floor(Math.random() * allBlackMoves.length)];
  const result = engine.applyMove(chosenMove.from, chosenMove.to);
  if (!result.ok) {
    console.error('[puzzle] generated an illegal reply for Black', chosenMove);
    return;
  }

  animateAndSound(result.move, result.status);
  puzzleSession.phase = 'player-turn';
  refreshStatusPanel();
  describeCurrentTask();
}

/** Shared "make the move visible and audible" step for both sides. */
function animateAndSound(move, status) {
  const boardView = puzzleSession.boardView;
  const moveWasAnimated = boardView.applyMove(move);
  if (!moveWasAnimated) {
    // The view somehow lost track of the position; rebuild rather than
    // continuing to draw something that is no longer true.
    boardView.rebuildFromEngine(puzzleSession.chessEngine);
  }
  boardView.setLastMove(move.from, move.to);
  boardView.setCheckedKing(
    status.isCheck ? puzzleSession.chessEngine.findKingSquare(status.sideToMove) : null
  );

  if (status.isCheckmate) {
    gameAudio.playCapture();
  } else if (move.captured) {
    gameAudio.playCapture();
  } else {
    gameAudio.playMove();
  }
  if (status.isCheck && !status.isCheckmate) {
    gameAudio.playCheck();
  }
}

function finishPuzzleAsSolved() {
  puzzleSession.phase = 'solved';
  refreshStatusPanel();
  setStatusMessage(
    `<strong>Checkmate.</strong> Solved in ${puzzleSession.playerMovesUsed} ` +
      `move${puzzleSession.playerMovesUsed === 1 ? '' : 's'}. Try the next puzzle.`
  );
  showToast('Checkmate — puzzle solved!', 'success', 3000);
  gameAudio.playGameOver({ didWin: true });
}

function finishPuzzleAsFailed(reason) {
  puzzleSession.phase = 'failed';
  refreshStatusPanel();
  setStatusMessage(`${reason} Tap <strong>Retry</strong> to start the position again.`);
  showToast('Not this time — tap Retry.', 'danger', 2600);
  gameAudio.playGameOver({ didWin: false });
}

/* ------------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------------ */

/**
 * Turn a tap on the board into a square.
 *
 * This listens directly on the render canvas and picks with
 * `boardView.pickSquareAtPointer()` — the same method Duel Mode's preview
 * mode uses — rather than going through A-Frame's `cursor`/`raycaster`
 * components. Those components only fire their `click` event when their own
 * raycaster currently has an intersected *entity*, and an intersection only
 * counts an object if it has `.el` bound to it. A-Frame stamps `.el` onto a
 * `setObject3D` tree exactly once, at the moment `setObject3D` is called
 * (see `initialisePuzzleMode` above) — every piece is added to the board
 * afterwards, in `loadPuzzle`, so no piece mesh is ever considered
 * "intersected" by A-Frame's own bookkeeping, and taps that land on one can
 * silently fail to fire `click` at all. Picking straight from the pointer
 * event sidesteps that gate entirely: it only needs the current camera and
 * the canvas's bounding box, both cheap to read fresh on every tap.
 *
 * The canvas sits under the HTML overlay, so taps on the overlay's buttons
 * never reach this listener — no manual "was this the interface" check
 * needed.
 */
function handleCanvasPointerDown(pointerEvent) {
  if (!puzzleSession.boardView || !puzzleSession.isMarkerVisible) {
    return;
  }

  const camera = pageElements.scene.camera;
  if (!camera) {
    return;
  }

  // THE ONE THAT ACTUALLY BREAKS TAPPING IN THIS MODE.
  //
  // AR.js replaces the camera's projection matrix with ARToolkit's calibrated
  // one — `camera.projectionMatrix.copy(arController.getProjectionMatrix())` —
  // but never calls `updateProjectionMatrix()`, so `projectionMatrixInverse`
  // is left holding A-Frame's DEFAULT lens (fov 80, window aspect). Three.js
  // renders through the first matrix and unprojects a tap through the second,
  // and the two only agree at the dead centre of the screen: the further from
  // centre the tap, the further the ray strays, until it resolves to a
  // neighbouring square or misses the board entirely. That is why a piece
  // could be picked up near the middle but the move to a square nearer the
  // edge silently deselected instead, and why a laptop — 4:3 webcam feed in a
  // wide window, so a much bigger mismatch — felt like nothing was clickable.
  //
  // Restoring the invariant Three.js maintains itself, on the live matrix, is
  // enough; it costs one 4x4 inversion per tap.
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

  const square = puzzleSession.boardView.pickSquareAtPointer(
    pointerEvent,
    camera,
    pageElements.scene.canvas
  );
  if (square) {
    handleSquareTapped(square);
  }
}

function wireUpControls() {
  pageElements.scene.canvas.addEventListener('pointerdown', handleCanvasPointerDown);

  pageElements.startButton.addEventListener('click', () => {
    // This tap is the user gesture the browser requires before audio may play.
    gameAudio.unlock();
    pageElements.loadingCurtain.hidden = true;
  });

  pageElements.hintButton.addEventListener('click', () => {
    showToast(currentPuzzle().hint, 'default', 5000);
  });

  pageElements.retryButton.addEventListener('click', () => {
    loadPuzzle(puzzleSession.puzzleIndex);
    showToast('Position reset.', 'default', 1400);
  });

  pageElements.nextButton.addEventListener('click', () => {
    loadPuzzle(puzzleSession.puzzleIndex + 1);
    showToast(`Puzzle ${puzzleSession.puzzleIndex + 1} of ${PUZZLES.length}`, 'default', 1600);
  });

  pageElements.soundButton.addEventListener('click', () => {
    const isNowMuted = gameAudio.toggleMuted();
    pageElements.soundButton.textContent = isNowMuted ? '🔇' : '🔊';
  });
}

initialisePuzzleMode();
