/**
 * duel-scene.js
 * =============
 * Duel Mode: the MARKERLESS half of the assignment's tracking requirement, and
 * the advanced feature (complex multi-step interaction) that sits on top of it.
 *
 * WHAT MAKES THIS MARKERLESS
 * --------------------------
 * There is no printed image to track. The page opens an `immersive-ar` WebXR
 * session and asks it for a hit-test source: every frame, the device reports
 * where a ray cast forward from the phone meets a real surface it has detected.
 * A reticle follows that point, and tapping "Place board" anchors the board
 * there in the session's `local` reference space — from then on the device's
 * own spatial tracking keeps it standing on the table while the player walks
 * around it.
 *
 * THE TWO-PLAYER MODEL (deliberate, and worth explaining in the report)
 * ---------------------------------------------------------------------
 * Each player places their OWN board in their OWN room. The two boards are not
 * registered to one shared physical space — no browser API can do that, since
 * it needs a cloud anchor service to relate two devices' coordinate systems.
 * What is shared is the game: moves travel over Socket.IO and both boards show
 * the same position, in the way an online quiz game shares questions rather
 * than a physical table.
 *
 * WHY THE CLIENT NEVER APPLIES ITS OWN MOVE FIRST
 * ------------------------------------------------
 * A tap sends an INTENT to the server and nothing else happens locally. The
 * board only changes when the server broadcasts the move back — to both
 * players, through the same code path. Applying the move optimistically would
 * be a few tens of milliseconds faster and would introduce an entire class of
 * bugs where one board believes something the other does not. The local
 * chess.js instance still exists, but only to answer "which squares can this
 * piece reach?" instantly while the player is choosing.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { ChessEngine } from './chess-engine.js';
import { PieceLoader } from './piece-loader.js';
import { BoardView } from './board-view.js';
import { createSceneLighting } from './board-builder.js';
import { SOCKET_SERVER_URL, BOARD_SCALE } from './config.js';
import { gameAudio } from './audio.js';

/* ------------------------------------------------------------------------ *
 * Page elements
 * ------------------------------------------------------------------------ */

const pageElements = {
  overlay: document.getElementById('arOverlay'),
  title: document.getElementById('duelTitle'),
  colourBadge: document.getElementById('colourBadge'),
  turnBadge: document.getElementById('turnBadge'),
  message: document.getElementById('duelMessage'),
  placeButton: document.getElementById('placeButton'),
  resignButton: document.getElementById('resignButton'),
  soundButton: document.getElementById('soundButton'),
  sizeRow: document.getElementById('sizeRow'),
  sizeSlider: document.getElementById('sizeSlider'),
  toast: document.getElementById('toast'),

  lobbyScreen: document.getElementById('lobbyScreen'),
  lobbyMessage: document.getElementById('lobbyMessage'),
  lobbyStatus: document.getElementById('lobbyStatus'),
  progressFill: document.getElementById('progressFill'),
  createButton: document.getElementById('createButton'),
  joinButton: document.getElementById('joinButton'),
  codeInput: document.getElementById('codeInput'),
  enterArButton: document.getElementById('enterArButton'),
  previewButton: document.getElementById('previewButton'),
};

/* ------------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------------ */

const duelSession = {
  /** 'loading' | 'lobby' | 'waiting-for-opponent' | 'ready' | 'playing' | 'finished' */
  phase: 'loading',
  socket: null,
  roomCode: null,
  /** 'w' or 'b' — which side this device is playing. */
  myColour: null,
  chessEngine: null,
  boardView: null,
  pieceLoader: null,
  selectedSquare: null,
  legalTargetsFromSelection: [],
  isBoardPlaced: false,
  /** 'ar' once an immersive session is running, 'preview' on a plain screen. */
  viewMode: null,
};

const renderContext = {
  renderer: null,
  scene: null,
  camera: null,
  reticle: null,
  hitTestSource: null,
  xrSession: null,
  clock: new THREE.Clock(),
  /** Reused so the render loop allocates nothing per frame. */
  scratchVector: new THREE.Vector3(),
  scratchRaycaster: new THREE.Raycaster(),
  scratchMatrix: new THREE.Matrix4(),
};

/* ------------------------------------------------------------------------ *
 * Interface helpers
 * ------------------------------------------------------------------------ */

let toastTimeoutId = null;

function showToast(message, variant = 'default', durationMs = 2400) {
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

function setMessage(htmlMessage) {
  pageElements.message.innerHTML = htmlMessage;
}

function setLobbyStatus(text) {
  pageElements.lobbyStatus.textContent = text;
}

/** Repaint the two badges in the AR heads-up display. */
function refreshBadges() {
  if (duelSession.myColour) {
    pageElements.colourBadge.textContent =
      duelSession.myColour === 'w' ? 'You: White' : 'You: Black';
  }

  if (duelSession.phase === 'finished') {
    pageElements.turnBadge.textContent = 'Game over';
    pageElements.turnBadge.className = 'status-badge';
    return;
  }
  if (duelSession.phase !== 'playing' || !duelSession.chessEngine) {
    pageElements.turnBadge.textContent = 'Waiting';
    pageElements.turnBadge.className = 'status-badge';
    return;
  }

  const isMyTurn = duelSession.chessEngine.getSideToMove() === duelSession.myColour;
  pageElements.turnBadge.textContent = isMyTurn ? 'Your move' : 'Their move';
  pageElements.turnBadge.className = `status-badge ${isMyTurn ? 'status-badge--live' : ''}`.trim();
}

/* ------------------------------------------------------------------------ *
 * Three.js setup
 * ------------------------------------------------------------------------ */

function buildRenderer() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;

  // The canvas sits underneath the interface layer, which is why the overlay's
  // z-index is higher and its background is transparent.
  Object.assign(renderer.domElement.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '1',
    display: 'block',
  });
  document.body.appendChild(renderer.domElement);

  window.addEventListener('resize', () => {
    renderContext.camera.aspect = window.innerWidth / window.innerHeight;
    renderContext.camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return renderer;
}

/**
 * The ring that shows where the board would land.
 *
 * `matrixAutoUpdate` is switched off because the hit-test result arrives as a
 * complete transform matrix each frame — letting Three.js recompute the matrix
 * from position/rotation/scale would simply overwrite it.
 */
function buildReticle() {
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.055, 0.075, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xf0c419, transparent: true, opacity: 0.9 })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  reticle.name = 'placementReticle';
  return reticle;
}

function buildScene() {
  const scene = new THREE.Scene();
  scene.add(createSceneLighting(THREE));

  renderContext.reticle = buildReticle();
  scene.add(renderContext.reticle);

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.01,
    40
  );

  renderContext.scene = scene;
  renderContext.camera = camera;
}

/* ------------------------------------------------------------------------ *
 * The render loop (shared by AR and preview)
 * ------------------------------------------------------------------------ */

/**
 * @param {number} timestamp
 * @param {XRFrame} [xrFrame] Supplied by the browser only inside an XR session.
 */
function renderFrame(timestamp, xrFrame) {
  // Clamped because the very first call reports the time since the clock was
  // created, and a backgrounded tab reports the whole time it was away — either
  // would fast-forward a piece straight through its animation.
  const deltaMilliseconds = Math.min(100, renderContext.clock.getDelta() * 1000);

  if (duelSession.boardView) {
    duelSession.boardView.update(deltaMilliseconds);
  }

  if (xrFrame && renderContext.hitTestSource && !duelSession.isBoardPlaced) {
    updatePlacementReticle(xrFrame);
  }

  renderContext.renderer.render(renderContext.scene, renderContext.camera);
}

/**
 * Move the reticle onto the nearest real surface in front of the phone.
 *
 * `getHitTestResults` returns results ordered nearest first, so the first one
 * is the surface the player is actually pointing at.
 */
function updatePlacementReticle(xrFrame) {
  const referenceSpace = renderContext.renderer.xr.getReferenceSpace();
  const hitTestResults = xrFrame.getHitTestResults(renderContext.hitTestSource);

  if (hitTestResults.length === 0) {
    renderContext.reticle.visible = false;
    pageElements.placeButton.disabled = true;
    return;
  }

  const surfacePose = hitTestResults[0].getPose(referenceSpace);
  if (!surfacePose) {
    return;
  }
  renderContext.reticle.visible = true;
  renderContext.reticle.matrix.fromArray(surfacePose.transform.matrix);
  pageElements.placeButton.disabled = false;
}

/* ------------------------------------------------------------------------ *
 * Placing the board
 * ------------------------------------------------------------------------ */

/**
 * Anchor the board where the reticle is, facing the player.
 *
 * The yaw is computed from the camera's position rather than taken from the
 * hit-test pose, because a hit test on a flat surface reports an essentially
 * arbitrary rotation about the vertical axis. Turning the board to face the
 * player means their own back rank is always the nearest one, which is how a
 * real board is set up and removes any need to walk around it.
 */
function placeBoardAtReticle() {
  if (!renderContext.reticle.visible) {
    showToast('No surface found yet — move the phone slowly.', 'danger');
    return;
  }

  const boardObject = duelSession.boardView.object3D;
  const placementPosition = new THREE.Vector3().setFromMatrixPosition(renderContext.reticle.matrix);
  boardObject.position.copy(placementPosition);

  const cameraPosition = getActiveCameraWorldPosition();
  boardObject.rotation.y = Math.atan2(
    cameraPosition.x - placementPosition.x,
    cameraPosition.z - placementPosition.z
  );

  boardObject.visible = true;
  duelSession.isBoardPlaced = true;
  renderContext.reticle.visible = false;

  pageElements.placeButton.textContent = 'Move board';
  pageElements.sizeRow.hidden = false;

  gameAudio.playSelect();
  describeCurrentTask();
}

/** Let the player pick the board up again and put it somewhere else. */
function unplaceBoard() {
  duelSession.isBoardPlaced = false;
  duelSession.boardView.object3D.visible = false;
  pageElements.placeButton.textContent = 'Place board';
  pageElements.sizeRow.hidden = true;
  setMessage('Point at a surface and tap <strong>Place board</strong> again.');
}

/**
 * Where the viewer actually is. Inside an XR session the real camera is the
 * one Three.js builds from the device pose, not the one in our scene.
 */
function getActiveCameraWorldPosition() {
  const source = renderContext.renderer.xr.isPresenting
    ? renderContext.renderer.xr.getCamera()
    : renderContext.camera;
  return source.getWorldPosition(renderContext.scratchVector);
}

/* ------------------------------------------------------------------------ *
 * Entering AR
 * ------------------------------------------------------------------------ */

/** Whether this browser and device can run an immersive AR session at all. */
async function isImmersiveArSupported() {
  if (!('xr' in navigator) || !navigator.xr) {
    return false;
  }
  try {
    return await navigator.xr.isSessionSupported('immersive-ar');
  } catch (supportError) {
    return false;
  }
}

async function startArSession() {
  try {
    const session = await navigator.xr.requestSession('immersive-ar', {
      // Without hit-test there is no markerless placement, so it is required
      // rather than optional: better to fail clearly than to start a session
      // that cannot do the one thing this mode needs.
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'local-floor'],
      domOverlay: { root: pageElements.overlay },
    });

    renderContext.xrSession = session;
    duelSession.viewMode = 'ar';

    pageElements.lobbyScreen.hidden = true;
    pageElements.overlay.hidden = false;

    renderContext.renderer.xr.setReferenceSpaceType('local');
    await renderContext.renderer.xr.setSession(session);

    // Hit testing is relative to the viewer: "what is in front of the phone".
    const viewerSpace = await session.requestReferenceSpace('viewer');
    renderContext.hitTestSource = await session.requestHitTestSource({ space: viewerSpace });

    session.addEventListener('select', handleXrSelect);
    session.addEventListener('end', handleArSessionEnded);

    describeCurrentTask();
  } catch (sessionError) {
    console.error('[duel] could not start the AR session:', sessionError);
    setLobbyStatus(
      'Could not start AR. The page must be served over HTTPS, and the browser ' +
        'needs camera permission. You can still play without AR.'
    );
    pageElements.previewButton.hidden = false;
  }
}

function handleArSessionEnded() {
  renderContext.hitTestSource = null;
  renderContext.xrSession = null;
  duelSession.isBoardPlaced = false;
  pageElements.overlay.hidden = true;
  pageElements.lobbyScreen.hidden = false;
  setLobbyStatus('AR session ended. You can go back in at any time.');
  pageElements.enterArButton.hidden = false;
}

/**
 * A tap inside the AR session.
 *
 * On a phone, a screen touch is an XR input source whose target ray runs from
 * the camera through the touched point, so the ray can be handed directly to
 * the raycaster — no screen-to-world conversion is needed. `event.frame` is
 * what makes the pose available here, in the event itself.
 */
function handleXrSelect(selectEvent) {
  if (!duelSession.boardView || !duelSession.isBoardPlaced) {
    return;
  }
  const referenceSpace = renderContext.renderer.xr.getReferenceSpace();
  const targetRayPose = selectEvent.frame.getPose(
    selectEvent.inputSource.targetRaySpace,
    referenceSpace
  );
  if (!targetRayPose) {
    return;
  }

  renderContext.scratchMatrix.fromArray(targetRayPose.transform.matrix);
  renderContext.scratchRaycaster.ray.origin.setFromMatrixPosition(renderContext.scratchMatrix);
  renderContext.scratchRaycaster.ray.direction
    .set(0, 0, -1)
    .transformDirection(renderContext.scratchMatrix);

  const square = duelSession.boardView.pickSquareWithRaycaster(renderContext.scratchRaycaster);
  if (square) {
    handleSquareTapped(square);
  }
}

/* ------------------------------------------------------------------------ *
 * Preview mode (no AR headset or phone required)
 * ------------------------------------------------------------------------ */

/**
 * Play on an ordinary screen, with the board floating in front of a fixed
 * camera instead of standing on a real table.
 *
 * This exists for two practical reasons: a laptop cannot run an immersive AR
 * session, and testing two-player logic is enormously easier with two browser
 * windows side by side than with two phones. It is also an honest fallback for
 * a device that turns out not to support WebXR at all.
 */
function startPreviewMode() {
  duelSession.viewMode = 'preview';
  pageElements.lobbyScreen.hidden = true;
  pageElements.overlay.hidden = false;

  renderContext.scene.background = new THREE.Color(0x1b1814);

  const boardObject = duelSession.boardView.object3D;
  boardObject.position.set(0, 0, 0);
  boardObject.visible = true;
  duelSession.isBoardPlaced = true;

  const boardWidthInMetres = 8 * Number(pageElements.sizeSlider.value) / 1000;
  renderContext.camera.position.set(0, boardWidthInMetres * 1.05, boardWidthInMetres * 1.15);
  renderContext.camera.lookAt(0, 0, 0);

  pageElements.placeButton.hidden = true;
  pageElements.sizeRow.hidden = false;

  // In preview there is no XR input source, so ordinary pointer events on the
  // canvas do the picking instead.
  renderContext.renderer.domElement.addEventListener('pointerdown', (pointerEvent) => {
    const square = duelSession.boardView.pickSquareAtPointer(
      pointerEvent,
      renderContext.camera,
      renderContext.renderer.domElement
    );
    if (square) {
      handleSquareTapped(square);
    }
  });

  describeCurrentTask();
}

/* ------------------------------------------------------------------------ *
 * Networking
 * ------------------------------------------------------------------------ */

function connectToRelayServer() {
  if (typeof window.io !== 'function') {
    setLobbyStatus('The Socket.IO client failed to load. Check your internet connection.');
    return;
  }

  setLobbyStatus(`Connecting to ${SOCKET_SERVER_URL}…`);
  const socket = window.io(SOCKET_SERVER_URL, {
    reconnectionAttempts: 5,
    timeout: 20000,
  });
  duelSession.socket = socket;

  socket.on('connect', () => {
    duelSession.phase = 'lobby';
    setLobbyStatus('Connected. Create a game, or join one with a code.');
    pageElements.createButton.disabled = false;
    pageElements.joinButton.disabled = false;
  });

  socket.on('connect_error', () => {
    // A free Render instance sleeps when idle, and the first request after a
    // nap can take the better part of a minute to wake it. Saying so prevents
    // the very reasonable assumption that the server is simply broken.
    setLobbyStatus(
      'Could not reach the game server yet. If it is hosted on a free plan it ' +
        'may be waking up — this can take up to a minute. Retrying…'
    );
  });

  socket.on('disconnect', () => {
    if (duelSession.phase === 'playing') {
      duelSession.phase = 'finished';
      setMessage('<strong>Connection lost.</strong> Reload the page to play again.');
      refreshBadges();
    }
  });

  socket.on('room-created', (payload) => {
    duelSession.roomCode = payload.code;
    duelSession.myColour = payload.yourColour;
    duelSession.phase = 'waiting-for-opponent';

    pageElements.lobbyMessage.innerHTML =
      `Your game code is <strong style="font-size:26px;letter-spacing:6px">${payload.code}</strong>`;
    setLobbyStatus('Waiting for the other player to join with that code…');
    pageElements.createButton.disabled = true;
    pageElements.joinButton.disabled = true;
    pageElements.codeInput.disabled = true;
  });

  socket.on('join-failed', (payload) => {
    setLobbyStatus(payload.reason || 'Could not join that game.');
    pageElements.createButton.disabled = false;
    pageElements.joinButton.disabled = false;
    pageElements.codeInput.disabled = false;
  });

  socket.on('game-start', (payload) => {
    duelSession.roomCode = payload.code;
    duelSession.myColour = payload.yourColour;
    duelSession.phase = 'playing';

    duelSession.chessEngine = new ChessEngine(payload.fen);
    duelSession.boardView.rebuildFromEngine(duelSession.chessEngine);
    duelSession.boardView.setBoardOrientation(payload.yourColour);
    duelSession.boardView.setLastMove(null, null);
    duelSession.boardView.setCheckedKing(null);

    pageElements.title.textContent = `Duel · ${payload.code}`;
    pageElements.lobbyMessage.innerHTML =
      `Opponent joined. You are playing <strong>${payload.yourColour === 'w' ? 'White' : 'Black'}</strong>.`;
    setLobbyStatus('Ready. Enter AR to place your board.');
    pageElements.enterArButton.hidden = false;
    pageElements.previewButton.hidden = false;
    refreshBadges();
  });

  socket.on('move-made', (payload) => {
    applyServerMove(payload);
  });

  socket.on('invalid-move', (payload) => {
    gameAudio.playRejected();
    showToast(payload.reason || 'That move was refused.', 'danger');
    clearSelection();
  });

  socket.on('opponent-left', (payload) => {
    duelSession.phase = 'finished';
    refreshBadges();
    setMessage(`<strong>${payload.reason || 'Your opponent left.'}</strong> Reload to play again.`);
    showToast(payload.reason || 'Your opponent left.', 'danger', 4000);
  });
}

/**
 * Apply an authoritative move from the server.
 *
 * The local engine replays the same move so that legal-move highlighting stays
 * correct, and the resulting FEN is then compared against the server's. A
 * mismatch means the two have drifted apart, and the only safe response is to
 * throw away the local position and rebuild from the server's — an ugly jump on
 * screen, but far better than two players seeing different boards.
 */
function applyServerMove(payload) {
  const engine = duelSession.chessEngine;
  const boardView = duelSession.boardView;
  if (!engine || !boardView) {
    return;
  }

  clearSelection();

  const localResult = engine.applyMove(payload.from, payload.to);
  let needsFullRebuild = !localResult.ok;

  if (localResult.ok) {
    const moveWasAnimated = boardView.applyMove({
      from: payload.from,
      to: payload.to,
      piece: payload.piece,
      colour: payload.colour,
      captured: payload.captured,
      promotion: payload.promotion,
    });
    needsFullRebuild = !moveWasAnimated || engine.getFen() !== payload.fen;
  }

  if (needsFullRebuild) {
    console.warn('[duel] local position drifted from the server; resynchronising');
    engine.loadFen(payload.fen);
    boardView.rebuildFromEngine(engine);
  }

  boardView.setLastMove(payload.from, payload.to);
  boardView.setCheckedKing(payload.isCheck ? engine.findKingSquare(payload.turn) : null);

  if (payload.captured) {
    gameAudio.playCapture();
  } else {
    gameAudio.playMove();
  }
  if (payload.isCheck && !payload.isCheckmate) {
    gameAudio.playCheck();
  }

  if (payload.isGameOver) {
    concludeGame(payload);
  } else {
    refreshBadges();
    describeCurrentTask();
  }
}

function concludeGame(payload) {
  duelSession.phase = 'finished';
  refreshBadges();

  if (payload.isCheckmate) {
    // The server has already switched sides, so the loser is the side to move.
    const didWin = payload.turn !== duelSession.myColour;
    setMessage(
      didWin
        ? '<strong>Checkmate — you win.</strong>'
        : '<strong>Checkmate — you lose.</strong>'
    );
    showToast(didWin ? 'Checkmate — you win!' : 'Checkmate — you lose.', didWin ? 'success' : 'danger', 5000);
    gameAudio.playGameOver({ didWin });
    return;
  }

  const drawReason = payload.isStalemate ? 'Stalemate' : 'Draw';
  setMessage(`<strong>${drawReason}.</strong> Neither player wins.`);
  showToast(`${drawReason} — the game is over.`, 'default', 5000);
  gameAudio.playGameOver({ didWin: false });
}

/* ------------------------------------------------------------------------ *
 * Playing
 * ------------------------------------------------------------------------ */

function handleSquareTapped(square) {
  if (duelSession.phase !== 'playing') {
    return;
  }
  if (!duelSession.isBoardPlaced) {
    showToast('Place your board first.', 'danger');
    return;
  }
  if (duelSession.boardView.isAnimating) {
    return;
  }

  const engine = duelSession.chessEngine;
  const isMyTurn = engine.getSideToMove() === duelSession.myColour;

  if (duelSession.selectedSquare) {
    if (square === duelSession.selectedSquare) {
      clearSelection();
      return;
    }
    const chosenTarget = duelSession.legalTargetsFromSelection.find(
      (target) => target.to === square
    );
    if (chosenTarget) {
      sendMoveToServer(duelSession.selectedSquare, square);
      return;
    }
    if (engine.isSquareOccupiedBy(square, duelSession.myColour) && isMyTurn) {
      selectSquare(square);
      return;
    }
    gameAudio.playRejected();
    clearSelection();
    return;
  }

  if (!isMyTurn) {
    showToast('Waiting for your opponent.', 'default', 1400);
    return;
  }
  if (engine.isSquareOccupiedBy(square, duelSession.myColour)) {
    selectSquare(square);
  } else if (engine.getPieceAt(square)) {
    showToast('That is your opponent’s piece.', 'danger', 1400);
    gameAudio.playRejected();
  }
}

function selectSquare(square) {
  const legalTargets = duelSession.chessEngine.listLegalDestinations(square);
  duelSession.selectedSquare = square;
  duelSession.legalTargetsFromSelection = legalTargets;
  duelSession.boardView.setSelection(square, legalTargets);

  if (legalTargets.length === 0) {
    showToast('That piece has no legal moves.', 'danger', 1400);
    gameAudio.playRejected();
  } else {
    gameAudio.playSelect();
  }
}

function clearSelection() {
  duelSession.selectedSquare = null;
  duelSession.legalTargetsFromSelection = [];
  if (duelSession.boardView) {
    duelSession.boardView.setSelection(null);
  }
}

/**
 * Send the move and wait. Nothing changes on this board until the server
 * broadcasts the move back — see the note at the top of this file.
 */
function sendMoveToServer(fromSquare, toSquare) {
  duelSession.socket.emit('make-move', {
    code: duelSession.roomCode,
    from: fromSquare,
    to: toSquare,
  });
  duelSession.boardView.setSelection(null);
  setMessage('Sending your move…');
}

/** The "what do I do now" line in the heads-up display. */
function describeCurrentTask() {
  if (duelSession.phase === 'finished') {
    return;
  }
  if (!duelSession.isBoardPlaced) {
    setMessage(
      'Move your phone slowly until a yellow ring appears on a flat surface, ' +
        'then tap <strong>Place board</strong>.'
    );
    return;
  }
  if (duelSession.phase !== 'playing') {
    setMessage('Waiting for the game to start…');
    return;
  }
  const isMyTurn = duelSession.chessEngine.getSideToMove() === duelSession.myColour;
  setMessage(
    isMyTurn
      ? 'Your move. Tap one of your pieces, then tap where it should go.'
      : 'Waiting for your opponent’s move.'
  );
}

/* ------------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------------ */

function wireUpControls() {
  // Inside a WebXR session with a DOM overlay, tapping a button would ALSO
  // fire an XR `select` event and be read as a tap on the board. Cancelling
  // `beforexrselect` on the overlay is the standard way to stop that.
  pageElements.overlay.addEventListener('beforexrselect', (event) => event.preventDefault());

  pageElements.createButton.addEventListener('click', () => {
    gameAudio.unlock();
    duelSession.socket.emit('create-room');
  });

  pageElements.joinButton.addEventListener('click', () => {
    gameAudio.unlock();
    const typedCode = pageElements.codeInput.value.trim().toUpperCase();
    if (typedCode === '') {
      setLobbyStatus('Please enter a game code.');
      return;
    }
    if (typedCode.length !== 4) {
      setLobbyStatus('A game code is four characters long.');
      return;
    }
    setLobbyStatus(`Joining game ${typedCode}…`);
    duelSession.socket.emit('join-room', { code: typedCode });
  });

  pageElements.codeInput.addEventListener('input', () => {
    // Room codes are always upper case, so normalise as the player types
    // rather than surprising them at submit time.
    pageElements.codeInput.value = pageElements.codeInput.value.toUpperCase();
  });

  pageElements.enterArButton.addEventListener('click', () => {
    gameAudio.unlock();
    startArSession();
  });

  pageElements.previewButton.addEventListener('click', () => {
    gameAudio.unlock();
    startPreviewMode();
  });

  pageElements.placeButton.addEventListener('click', () => {
    if (duelSession.isBoardPlaced) {
      unplaceBoard();
    } else {
      placeBoardAtReticle();
    }
  });

  pageElements.resignButton.addEventListener('click', () => {
    duelSession.socket.emit('leave-room');
    if (renderContext.xrSession) {
      renderContext.xrSession.end();
    } else {
      window.location.href = './index.html';
    }
  });

  pageElements.soundButton.addEventListener('click', () => {
    const isNowMuted = gameAudio.toggleMuted();
    pageElements.soundButton.textContent = isNowMuted ? '🔇' : '🔊';
  });

  pageElements.sizeSlider.addEventListener('input', () => {
    // The slider is in millimetres per square, which keeps the numbers
    // meaningful: 45 means a 45 mm square, so a 36 cm board.
    const metresPerSquare = Number(pageElements.sizeSlider.value) / 1000;
    duelSession.boardView.object3D.scale.setScalar(metresPerSquare);

    // In preview mode the camera is fixed, so it has to be pulled back as the
    // board grows or the board would simply overflow the screen.
    if (duelSession.viewMode === 'preview') {
      const boardWidthInMetres = 8 * metresPerSquare;
      renderContext.camera.position.set(0, boardWidthInMetres * 1.05, boardWidthInMetres * 1.15);
      renderContext.camera.lookAt(0, 0, 0);
    }
  });
}

/* ------------------------------------------------------------------------ *
 * Start-up
 * ------------------------------------------------------------------------ */

async function initialiseDuelMode() {
  renderContext.renderer = buildRenderer();
  buildScene();

  // No top-icon discs here: this board is looked at from a standing 3/4
  // angle, where the models' own silhouettes are already telling and a disc
  // over each crown would only cover them up.
  duelSession.pieceLoader = new PieceLoader({ THREE, GLTFLoader, showTopIcons: false });
  try {
    await duelSession.pieceLoader.loadAllPieces((loadedCount, totalCount) => {
      pageElements.progressFill.style.width = `${(loadedCount / totalCount) * 100}%`;
      setLobbyStatus(`Loading 3D pieces… ${loadedCount} of ${totalCount}`);
    });
  } catch (loadError) {
    console.error('[duel] failed to load piece models:', loadError);
    setLobbyStatus('Could not load the 3D pieces. Check that assets/models/ was deployed.');
    return;
  }

  duelSession.boardView = new BoardView({ THREE, pieceLoader: duelSession.pieceLoader });
  duelSession.boardView.object3D.scale.setScalar(BOARD_SCALE.DUEL_DEFAULT);
  duelSession.boardView.object3D.visible = false;
  renderContext.scene.add(duelSession.boardView.object3D);

  // An empty board is shown in the lobby so something sensible is on screen
  // the moment the player enters AR, before any game has started.
  duelSession.chessEngine = new ChessEngine();
  duelSession.boardView.rebuildFromEngine(duelSession.chessEngine);

  wireUpControls();
  renderContext.renderer.setAnimationLoop(renderFrame);

  if (await isImmersiveArSupported()) {
    setLobbyStatus('Ready. Connecting to the game server…');
  } else {
    pageElements.previewButton.hidden = false;
    setLobbyStatus(
      'This browser cannot run AR (it needs WebXR, HTTPS and a supported ' +
        'device — Chrome on Android is the usual choice). You can still play ' +
        'without AR.'
    );
  }

  connectToRelayServer();
}

initialiseDuelMode();
