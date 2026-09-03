/**
 * puzzle-scene.js
 * ===============
 * Puzzle Mode: the MARKER-BASED half of the assignment's tracking requirement.
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
import { FlatPieceLoader } from './flat-piece-loader.js';
import { BoardView } from './board-view.js';
import { createSceneLighting } from './board-builder.js';
import { PUZZLES } from './puzzles.js';
import { BOARD_SCALE } from './config.js';
import { gameAudio } from './audio.js';

/* ------------------------------------------------------------------------ *
 * Page elements
 * ------------------------------------------------------------------------ */

const pageElements = {
  scene: document.querySelector('a-scene'),
  marker: document.getElementById('chessMarker'),
  tapCursor: document.getElementById('tapCursor'),
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
  // compatible with the A-Frame scene graph.
  const THREE = AFRAME.THREE;

  puzzleSession.pieceLoader = new FlatPieceLoader({ THREE });

  await puzzleSession.pieceLoader.loadAllPieces((loadedCount, totalCount) => {
    pageElements.progressFill.style.width = `${(loadedCount / totalCount) * 100}%`;
    pageElements.loadingText.textContent = `Preparing pieces… ${loadedCount} of ${totalCount}`;
  });

  puzzleSession.boardView = new BoardView({ THREE, pieceLoader: puzzleSession.pieceLoader });
  puzzleSession.boardView.object3D.scale.setScalar(BOARD_SCALE.PUZZLE);
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
 * Picking is delegated to A-Frame's own `cursor`/`raycaster` components
 * (`#tapCursor` in puzzle.html, parented under the camera entity) rather than
 * a hand-built raycaster: they are driven directly by the live camera object
 * AR.js updates every frame, and already handle the touch-vs-mouse event
 * differences correctly. Reaching for `sceneEl.camera` ourselves risked using
 * a stale or otherwise-mismatched camera reference, which would explain
 * taps that silently miss even when the board looks correctly tracked.
 *
 * The cursor only listens on the canvas, so taps on the HTML overlay's
 * buttons never reach it — no manual "was this the interface" check needed.
 */
function handleTapCursorClick() {
  if (!puzzleSession.boardView || !puzzleSession.isMarkerVisible) {
    return;
  }

  const raycasterComponent = pageElements.tapCursor.components.raycaster;
  if (!raycasterComponent) {
    return;
  }

  const square = puzzleSession.boardView.pickSquareWithRaycaster(raycasterComponent.raycaster);
  if (square) {
    handleSquareTapped(square);
  }
}

function wireUpControls() {
  pageElements.tapCursor.addEventListener('click', handleTapCursorClick);

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
