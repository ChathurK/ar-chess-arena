/**
 * relay-integration-test.mjs
 * ==========================
 * End-to-end test of the Duel Mode backend, run with `npm run test:relay`.
 *
 * This deliberately starts the REAL server and connects REAL Socket.IO clients
 * over a real TCP port rather than calling the relay's functions directly. The
 * failures that matter in a networked game — a client sending the wrong shape
 * of payload, an event that goes to one socket instead of both, a disconnect
 * that leaves the other player hanging — only exist at that boundary, and unit
 * tests of the handlers would step straight over every one of them.
 *
 * The scenarios below are exactly the ones that decide whether the demo works:
 * creating and joining a room, refusing a move made out of turn, refusing an
 * illegal move, agreeing on the position after every legal move, detecting
 * checkmate, and telling a player when their opponent vanishes.
 */

import assert from 'node:assert/strict';
import { io as createSocketClient } from 'socket.io-client';

/** A high, unlikely-to-be-busy port so the test never fights a dev server. */
const TEST_PORT = 45217;
const SERVER_URL = `http://127.0.0.1:${TEST_PORT}`;
const EVENT_TIMEOUT_MS = 5000;

process.env.PORT = String(TEST_PORT);
process.env.ALLOWED_ORIGINS = '';

const backend = await import('../backend/server.js');
const { httpServer, io: socketServer, relay } = backend.default || backend;

/* ------------------------------------------------------------------------ *
 * Small test harness
 * ------------------------------------------------------------------------ */

let passedCheckCount = 0;

function reportPass(description) {
  passedCheckCount += 1;
  console.log(`  ok  ${description}`);
}

/** Wait for one named event, failing loudly rather than hanging forever. */
function waitForEvent(socket, eventName, timeoutMs = EVENT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      socket.off(eventName, handleEvent);
      reject(new Error(`timed out after ${timeoutMs}ms waiting for "${eventName}"`));
    }, timeoutMs);

    function handleEvent(payload) {
      clearTimeout(timeoutId);
      socket.off(eventName, handleEvent);
      resolve(payload);
    }
    socket.on(eventName, handleEvent);
  });
}

function connectClient() {
  const socket = createSocketClient(SERVER_URL, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  return socket;
}

/**
 * Play one move and collect the `move-made` broadcast as seen by BOTH clients.
 * Asserting on both is the point: a relay bug that updates only the mover's
 * board is invisible if you look at one side.
 */
async function playMove({ mover, opponent, code, from, to }) {
  const moverSees = waitForEvent(mover, 'move-made');
  const opponentSees = waitForEvent(opponent, 'move-made');
  mover.emit('make-move', { code, from, to });
  return { mover: await moverSees, opponent: await opponentSees };
}

/* ------------------------------------------------------------------------ *
 * Scenarios
 * ------------------------------------------------------------------------ */

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

async function testJoiningAndPlaying() {
  console.log('\ncreate, join and play');

  const whiteClient = connectClient();
  const blackClient = connectClient();
  await waitForEvent(whiteClient, 'connect');
  await waitForEvent(blackClient, 'connect');
  reportPass('both clients connect');

  // --- create ------------------------------------------------------------
  const roomCreated = waitForEvent(whiteClient, 'room-created');
  whiteClient.emit('create-room');
  const { code, yourColour } = await roomCreated;

  assert.match(code, /^[A-Z0-9]{4}$/, 'room code should be four unambiguous characters');
  assert.equal(yourColour, 'w', 'the player who creates a room plays White');
  reportPass(`room ${code} created, creator is White`);

  // --- a room that does not exist ----------------------------------------
  const joinFailed = waitForEvent(blackClient, 'join-failed');
  blackClient.emit('join-room', { code: 'ZZZZ' });
  const joinFailure = await joinFailed;
  assert.ok(joinFailure.reason, 'a failed join must explain itself');
  reportPass('joining a non-existent room is refused with a reason');

  // --- join --------------------------------------------------------------
  const whiteStarts = waitForEvent(whiteClient, 'game-start');
  const blackStarts = waitForEvent(blackClient, 'game-start');
  blackClient.emit('join-room', { code: code.toLowerCase() }); // lower case on purpose
  const whiteStart = await whiteStarts;
  const blackStart = await blackStarts;

  assert.equal(whiteStart.yourColour, 'w');
  assert.equal(blackStart.yourColour, 'b');
  assert.equal(whiteStart.fen, STARTING_FEN, 'a new game starts from the standard position');
  assert.equal(blackStart.fen, STARTING_FEN);
  reportPass('both players receive game-start with their own colour (code is case-insensitive)');

  // --- moving out of turn -------------------------------------------------
  const outOfTurnRejected = waitForEvent(blackClient, 'invalid-move');
  blackClient.emit('make-move', { code, from: 'e7', to: 'e5' });
  const outOfTurn = await outOfTurnRejected;
  assert.match(outOfTurn.reason, /not your turn/i);
  reportPass('Black moving first is refused: it is not their turn');

  // --- an illegal move ----------------------------------------------------
  const illegalRejected = waitForEvent(whiteClient, 'invalid-move');
  whiteClient.emit('make-move', { code, from: 'e2', to: 'e5' });
  const illegal = await illegalRejected;
  assert.match(illegal.reason, /not legal/i);
  reportPass('a pawn moving three squares is refused as illegal');

  // --- a malformed payload -------------------------------------------------
  const malformedRejected = waitForEvent(whiteClient, 'invalid-move');
  whiteClient.emit('make-move', { code, from: 42, to: null });
  await malformedRejected;
  reportPass('a malformed move payload is refused rather than crashing the server');

  // --- a legal move, seen identically by both ------------------------------
  const firstMove = await playMove({
    mover: whiteClient,
    opponent: blackClient,
    code,
    from: 'e2',
    to: 'e4',
  });
  assert.deepEqual(firstMove.mover, firstMove.opponent, 'both players must see the same broadcast');
  assert.equal(firstMove.mover.from, 'e2');
  assert.equal(firstMove.mover.to, 'e4');
  assert.equal(firstMove.mover.piece, 'p');
  assert.equal(firstMove.mover.colour, 'w');
  assert.equal(firstMove.mover.turn, 'b', 'it is Black to move after White plays');
  assert.equal(firstMove.mover.isCheck, false);
  reportPass('a legal move is broadcast identically to both players');

  whiteClient.disconnect();
  blackClient.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 120));
}

async function testCheckmateIsDetected() {
  console.log('\ncheckmate detection (Fool’s Mate)');

  const whiteClient = connectClient();
  const blackClient = connectClient();
  await waitForEvent(whiteClient, 'connect');
  await waitForEvent(blackClient, 'connect');

  const roomCreated = waitForEvent(whiteClient, 'room-created');
  whiteClient.emit('create-room');
  const { code } = await roomCreated;

  const bothStarted = Promise.all([
    waitForEvent(whiteClient, 'game-start'),
    waitForEvent(blackClient, 'game-start'),
  ]);
  blackClient.emit('join-room', { code });
  await bothStarted;

  // The shortest possible checkmate: 1. f3 e5 2. g4 Qh4#
  await playMove({ mover: whiteClient, opponent: blackClient, code, from: 'f2', to: 'f3' });
  await playMove({ mover: blackClient, opponent: whiteClient, code, from: 'e7', to: 'e5' });
  await playMove({ mover: whiteClient, opponent: blackClient, code, from: 'g2', to: 'g4' });
  const mateMove = await playMove({
    mover: blackClient,
    opponent: whiteClient,
    code,
    from: 'd8',
    to: 'h4',
  });

  assert.equal(mateMove.mover.isCheck, true, 'the mating move gives check');
  assert.equal(mateMove.mover.isCheckmate, true, 'the mating move is checkmate');
  assert.equal(mateMove.mover.isGameOver, true);
  assert.equal(mateMove.mover.turn, 'w', 'the mated side is the one left to move');
  assert.deepEqual(mateMove.mover, mateMove.opponent);
  reportPass('checkmate is detected by the server and reported to both players');

  // A finished game must refuse further moves rather than quietly playing on.
  const afterMateRejected = waitForEvent(whiteClient, 'invalid-move');
  whiteClient.emit('make-move', { code, from: 'g1', to: 'f3' });
  await afterMateRejected;
  reportPass('moves after checkmate are refused');

  whiteClient.disconnect();
  blackClient.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 120));
}

async function testOpponentDisconnect() {
  console.log('\ndisconnect handling');

  const whiteClient = connectClient();
  const blackClient = connectClient();
  await waitForEvent(whiteClient, 'connect');
  await waitForEvent(blackClient, 'connect');

  const roomCreated = waitForEvent(whiteClient, 'room-created');
  whiteClient.emit('create-room');
  const { code } = await roomCreated;

  const bothStarted = Promise.all([
    waitForEvent(whiteClient, 'game-start'),
    waitForEvent(blackClient, 'game-start'),
  ]);
  blackClient.emit('join-room', { code });
  await bothStarted;
  assert.ok(relay.rooms.has(code), 'the room should exist while the game is running');

  const opponentLeft = waitForEvent(blackClient, 'opponent-left');
  whiteClient.disconnect();
  const departure = await opponentLeft;
  assert.ok(departure.reason, 'the remaining player is told why the game ended');
  reportPass('the remaining player is notified when their opponent disconnects');

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(!relay.rooms.has(code), 'the room is cleaned up, not leaked');
  reportPass('the abandoned room is removed from memory');

  blackClient.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 120));
}

/* ------------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------------ */

try {
  await testJoiningAndPlaying();
  await testCheckmateIsDetected();
  await testOpponentDisconnect();

  assert.equal(relay.rooms.size, 0, 'no rooms should be left behind after the tests');
  console.log(`\nAll ${passedCheckCount} relay checks passed.`);
  process.exitCode = 0;
} catch (testError) {
  console.error('\nRELAY TEST FAILED:', testError.message);
  process.exitCode = 1;
} finally {
  socketServer.close();
  httpServer.close();
  relay.shutdown();
  // Socket.IO keeps a few handles alive briefly; exiting explicitly keeps the
  // test from appearing to hang in CI.
  setTimeout(() => process.exit(process.exitCode || 0), 300).unref();
}
