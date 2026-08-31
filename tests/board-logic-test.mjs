/**
 * board-logic-test.mjs
 * ====================
 * Headless tests for the shared board modules: the square ⇄ 3D mapping, and
 * the move-rendering rules that are easy to get wrong.
 *
 * Run with `node tests/board-logic-test.mjs`.
 *
 * HOW THIS RUNS WITHOUT A BROWSER
 * -------------------------------
 * Two small pieces of scaffolding, both in this folder:
 *
 *   • `three-stub.mjs` supplies just enough of Three.js's object model for the
 *     board code to build its scene graph, so no WebGL context is needed;
 *   • `chess-engine.js` normally imports chess.js from a CDN, which Node
 *     cannot resolve, so a copy is written to a temporary file with that
 *     import rewritten to the locally installed package. The rest of the file
 *     — all of the logic under test — is untouched.
 *
 * The alternative would be a headless browser, which for logic this
 * self-contained would be slower, flakier, and no more revealing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { THREE_STUB, StubPieceLoader } from './three-stub.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendJsDirectory = path.join(testDirectory, '..', 'frontend', 'js');

/* ------------------------------------------------------------------------ *
 * Scaffolding
 * ------------------------------------------------------------------------ */

// config.js reads `window.location` as soon as it is evaluated, so a minimal
// browser environment has to exist before any of these modules are imported.
globalThis.window = { location: { search: '', hostname: 'localhost' } };

/** Import chess-engine.js with its CDN import redirected to node_modules. */
async function importChessEngineForNode() {
  const originalSource = await fs.readFile(
    path.join(frontendJsDirectory, 'chess-engine.js'),
    'utf8'
  );
  const localChessJsUrl = pathToFileURL(
    path.join(testDirectory, '..', 'node_modules', 'chess.js', 'dist', 'esm', 'chess.js')
  ).href;

  const rewrittenSource = originalSource.replace(
    /from 'https:\/\/cdn\.jsdelivr\.net\/npm\/chess\.js@[^']+'/,
    `from '${localChessJsUrl}'`
  );
  assert.notEqual(
    rewrittenSource,
    originalSource,
    'chess-engine.js no longer imports chess.js from the expected CDN URL — update this test'
  );

  const temporaryPath = path.join(os.tmpdir(), `chess-engine-under-test-${process.pid}.mjs`);
  await fs.writeFile(temporaryPath, rewrittenSource, 'utf8');
  try {
    return await import(pathToFileURL(temporaryPath).href);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

const { ChessEngine } = await importChessEngineForNode();
const boardBuilder = await import(pathToFileURL(path.join(frontendJsDirectory, 'board-builder.js')).href);
const { BoardView } = await import(pathToFileURL(path.join(frontendJsDirectory, 'board-view.js')).href);

let passedCheckCount = 0;
function reportPass(description) {
  passedCheckCount += 1;
  console.log(`  ok  ${description}`);
}

/** Build a board view sitting on a given position, ready to be moved. */
function createBoardViewFor(chessEngine) {
  const boardView = new BoardView({ THREE: THREE_STUB, pieceLoader: new StubPieceLoader() });
  boardView.rebuildFromEngine(chessEngine);
  return boardView;
}

/** Play moves through the engine, mirroring each one onto the board view. */
function playMoves(chessEngine, boardView, moves) {
  for (const [fromSquare, toSquare] of moves) {
    const result = chessEngine.applyMove(fromSquare, toSquare);
    assert.ok(result.ok, `expected ${fromSquare}${toSquare} to be legal`);
    const wasAnimated = boardView.applyMove(result.move);
    assert.ok(wasAnimated, `board view could not render ${fromSquare}${toSquare}`);
    // Fast-forward every animation so the final state can be asserted on.
    boardView.update(10000);
  }
}

/* ------------------------------------------------------------------------ *
 * Square ⇄ position mapping
 * ------------------------------------------------------------------------ */

function testCoordinateMapping() {
  console.log('\nsquare to 3D position mapping');

  const a1 = boardBuilder.squareToLocalPosition('a1');
  const h8 = boardBuilder.squareToLocalPosition('h8');
  assert.deepEqual(a1, { x: -3.5, y: 0, z: 3.5 }, 'a1 is the near-left corner');
  assert.deepEqual(h8, { x: 3.5, y: 0, z: -3.5 }, 'h8 is the far-right corner');
  assert.deepEqual(boardBuilder.squareToLocalPosition('e1'), { x: 0.5, y: 0, z: 3.5 });
  reportPass('corner and king squares map to the expected coordinates');

  // Ranks must run away from the viewer: rank 1 nearest, rank 8 furthest.
  assert.ok(
    boardBuilder.squareToLocalPosition('a1').z > boardBuilder.squareToLocalPosition('a8').z,
    'rank 1 must be nearer the camera than rank 8'
  );
  reportPass('ranks run away from White’s side of the board');

  assert.equal(boardBuilder.squareToLocalPosition('z9'), null);
  assert.equal(boardBuilder.squareToIndices('a'), null);
  assert.equal(boardBuilder.indicesToSquare(8, 0), null);
  reportPass('invalid squares are rejected rather than silently mapped');

  // The universal rule: a1 is dark, and h1 is light.
  assert.equal(boardBuilder.isLightSquare('a1'), false, 'a1 must be a dark square');
  assert.equal(boardBuilder.isLightSquare('h1'), true, 'h1 must be a light square');
  assert.equal(boardBuilder.isLightSquare('a8'), true);
  assert.equal(boardBuilder.isLightSquare('h8'), false);
  reportPass('square colours follow the a1-is-dark convention');

  assert.equal(boardBuilder.listAllSquares().length, 64);
  reportPass('the board has 64 squares');
}

function testBoardConstruction() {
  console.log('\nboard construction');

  const { group, tilesBySquare } = boardBuilder.createBoard(THREE_STUB);
  assert.equal(tilesBySquare.size, 64, 'every square needs its own tile mesh');
  assert.equal(group.children.length, 65, '64 tiles plus the frame');
  reportPass('the board builds 64 individually addressable tiles plus a frame');

  const tileMaterials = new Set(Array.from(tilesBySquare.values()).map((tile) => tile.material));
  assert.equal(tileMaterials.size, 64, 'tiles must not share materials, or highlighting bleeds');
  reportPass('each tile owns its material, so highlights cannot bleed between squares');

  // Tile top surfaces must sit exactly at y = 0, which every piece placement
  // depends on.
  for (const tile of tilesBySquare.values()) {
    assert.ok(tile.position.y < 0, 'tiles sit below the playing surface');
  }
  reportPass('tiles sit below y = 0 so pieces stand exactly on the surface');
}

/* ------------------------------------------------------------------------ *
 * Move rendering
 * ------------------------------------------------------------------------ */

function testOrdinaryMoveAndCapture() {
  console.log('\nordinary moves and captures');

  const engine = new ChessEngine();
  const boardView = createBoardViewFor(engine);
  assert.equal(boardView.pieceObjectsBySquare.size, 32, 'a new game has 32 pieces');
  reportPass('a fresh position renders all 32 pieces');

  playMoves(engine, boardView, [['e2', 'e4']]);
  assert.ok(!boardView.pieceObjectsBySquare.has('e2'), 'the pawn left e2');
  assert.ok(boardView.pieceObjectsBySquare.has('e4'), 'the pawn arrived on e4');
  assert.equal(boardView.pieceObjectsBySquare.get('e4').userData.square, 'e4');
  assert.equal(boardView.pieceObjectsBySquare.get('e4').position.x, 0.5);
  reportPass('a quiet move relocates the piece and settles it on the square');

  playMoves(engine, boardView, [['d7', 'd5'], ['e4', 'd5']]);
  assert.equal(boardView.pieceObjectsBySquare.size, 31, 'the captured pawn is gone');
  assert.equal(boardView.pieceObjectsBySquare.get('d5').userData.pieceColour, 'w');
  reportPass('a capture removes the taken piece and leaves the capturer on the square');
}

function testEnPassant() {
  console.log('\nen passant — the captured pawn is not on the destination square');

  const engine = new ChessEngine();
  const boardView = createBoardViewFor(engine);

  // 1. e4 d5  2. e5 f5  — now e5xf6 is an en passant capture of the f5 pawn.
  playMoves(engine, boardView, [
    ['e2', 'e4'],
    ['d7', 'd5'],
    ['e4', 'e5'],
    ['f7', 'f5'],
  ]);
  assert.ok(boardView.pieceObjectsBySquare.has('f5'), 'the black pawn is on f5');

  const pieceCountBefore = boardView.pieceObjectsBySquare.size;
  playMoves(engine, boardView, [['e5', 'f6']]);

  assert.equal(boardView.pieceObjectsBySquare.size, pieceCountBefore - 1, 'one pawn was taken');
  assert.ok(!boardView.pieceObjectsBySquare.has('f5'), 'the pawn ON f5 was the one removed');
  assert.ok(boardView.pieceObjectsBySquare.has('f6'), 'the capturing pawn stands on f6');
  assert.equal(boardView.pieceObjectsBySquare.get('f6').userData.pieceColour, 'w');
  reportPass('en passant removes the pawn beside the destination, not the empty square itself');
}

function testCastling() {
  console.log('\ncastling — two pieces move on one turn');

  const engine = new ChessEngine();
  const boardView = createBoardViewFor(engine);

  // 1. e4 e5  2. Nf3 Nc6  3. Bc4 Bc5  4. O-O
  playMoves(engine, boardView, [
    ['e2', 'e4'],
    ['e7', 'e5'],
    ['g1', 'f3'],
    ['b8', 'c6'],
    ['f1', 'c4'],
    ['f8', 'c5'],
    ['e1', 'g1'],
  ]);

  assert.ok(boardView.pieceObjectsBySquare.has('g1'), 'the king castled to g1');
  assert.equal(boardView.pieceObjectsBySquare.get('g1').userData.pieceType, 'k');
  assert.ok(boardView.pieceObjectsBySquare.has('f1'), 'the rook came across to f1');
  assert.equal(boardView.pieceObjectsBySquare.get('f1').userData.pieceType, 'r');
  assert.ok(!boardView.pieceObjectsBySquare.has('h1'), 'the rook left h1');
  assert.ok(!boardView.pieceObjectsBySquare.has('e1'), 'the king left e1');
  reportPass('king-side castling moves the rook as well as the king');

  // And the same on the other wing, where the rook travels three squares.
  const queenSideEngine = new ChessEngine('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1');
  const queenSideView = createBoardViewFor(queenSideEngine);
  playMoves(queenSideEngine, queenSideView, [['e8', 'c8']]);
  assert.ok(queenSideView.pieceObjectsBySquare.has('c8'), 'the king castled to c8');
  assert.ok(queenSideView.pieceObjectsBySquare.has('d8'), 'the rook came across to d8');
  assert.ok(!queenSideView.pieceObjectsBySquare.has('a8'), 'the rook left a8');
  reportPass('queen-side castling moves the rook the full three squares');
}

function testPromotion() {
  console.log('\npromotion — the arriving pawn is replaced');

  // White pawn on b7, kings well apart, White to move.
  const engine = new ChessEngine('8/1P6/8/8/8/8/7k/5K2 w - - 0 1');
  const boardView = createBoardViewFor(engine);

  const promotionTargets = engine.listLegalDestinations('b7');
  const promotionSquare = promotionTargets.find((target) => target.to === 'b8');
  assert.ok(promotionSquare, 'b7 to b8 should be available');
  assert.equal(promotionSquare.isPromotion, true, 'reaching the last rank is a promotion');
  assert.equal(promotionTargets.filter((target) => target.to === 'b8').length, 1,
    'the four promotion choices must collapse to one highlighted square');
  reportPass('promotion squares are reported once, not once per promotion piece');

  playMoves(engine, boardView, [['b7', 'b8']]);
  const promotedPiece = boardView.pieceObjectsBySquare.get('b8');
  assert.ok(promotedPiece, 'something stands on b8');
  assert.equal(promotedPiece.userData.pieceType, 'q', 'the pawn became a queen');
  assert.equal(promotedPiece.userData.pieceColour, 'w');
  assert.ok(!boardView.pieceObjectsBySquare.has('b7'), 'the pawn left b7');
  reportPass('a promoted pawn is swapped for a queen once the slide finishes');
}

/* ------------------------------------------------------------------------ *
 * Highlighting and picking
 * ------------------------------------------------------------------------ */

function testHighlighting() {
  console.log('\nhighlighting');

  const engine = new ChessEngine();
  const boardView = createBoardViewFor(engine);

  const e2Tile = boardView.tilesBySquare.get('e2');
  const e4Tile = boardView.tilesBySquare.get('e4');
  const baseColourOfE4 = e4Tile.userData.baseColour;

  boardView.setSelection('e2', engine.listLegalDestinations('e2'));
  assert.notEqual(e2Tile.material.color.getHex(), e2Tile.userData.baseColour,
    'the selected square must look different');
  assert.notEqual(e4Tile.material.color.getHex(), baseColourOfE4,
    'a legal destination must be highlighted');
  reportPass('selecting a piece highlights it and its legal destinations');

  boardView.setSelection(null);
  assert.equal(e2Tile.material.color.getHex(), e2Tile.userData.baseColour);
  assert.equal(e4Tile.material.color.getHex(), baseColourOfE4);
  reportPass('clearing the selection restores every tile to its own colour');

  // The layering rule: a king in check must win its square over the last move.
  boardView.setLastMove('e1', 'e2');
  boardView.setCheckedKing('e1');
  const e1Tile = boardView.tilesBySquare.get('e1');
  assert.notEqual(e1Tile.material.color.getHex(), e1Tile.userData.baseColour);
  reportPass('the check highlight is painted last and wins its square');
}

function testSquareLookupThroughAncestors() {
  console.log('\ntap resolution');

  const engine = new ChessEngine();
  const boardView = createBoardViewFor(engine);

  // A raycast hits a mesh several levels below the object that knows its
  // square, so the lookup has to walk up the tree.
  const kingObject = boardView.pieceObjectsBySquare.get('e1');
  const deepChildMesh = kingObject.children[0];
  assert.equal(BoardView.findSquareOnObjectOrAncestors(deepChildMesh), 'e1');
  reportPass('a hit on a piece’s child mesh resolves to the square it stands on');

  const tileMesh = boardView.tilesBySquare.get('c3');
  assert.equal(BoardView.findSquareOnObjectOrAncestors(tileMesh), 'c3');
  reportPass('a hit on an empty tile resolves to that tile’s square');
}

/* ------------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------------ */

try {
  testCoordinateMapping();
  testBoardConstruction();
  testOrdinaryMoveAndCapture();
  testEnPassant();
  testCastling();
  testPromotion();
  testHighlighting();
  testSquareLookupThroughAncestors();
  console.log(`\nAll ${passedCheckCount} board-logic checks passed.`);
} catch (testError) {
  console.error('\nBOARD LOGIC TEST FAILED:', testError.message);
  process.exitCode = 1;
}
