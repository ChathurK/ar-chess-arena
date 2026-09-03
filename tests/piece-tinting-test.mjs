/**
 * piece-tinting-test.mjs
 * ======================
 * Headless tests for how piece-loader.js turns six neutral models into twelve
 * coloured pieces.
 *
 * Run with `node tests/piece-tinting-test.mjs`.
 *
 * WHY THIS IS WORTH TESTING
 * -------------------------
 * Tinting fails quietly. Every failure mode here produces a scene that renders
 * perfectly happily and is simply the wrong colour: an accent mesh that stops
 * being recognised turns the whole set one flat tone, a shared material makes
 * tinting one side repaint the other, and a malformed palette paints
 * everything black. None of it throws, none of it shows up in a static check,
 * and all of it is only visible on a phone in AR — which is the worst possible
 * place to discover it.
 *
 * It also pins down the contract between the two model sets. The generated set
 * in assets/models/ is one unnamed mesh per piece; the imported set produced by
 * scripts/extract_chess_pieces.py is a "body" mesh plus an "accent" mesh. Both
 * have to work through the same loader, because switching between them is
 * meant to be a MODEL_BASE_PATH change and nothing more.
 *
 * HOW THIS RUNS WITHOUT A BROWSER
 * -------------------------------
 * `three-stub.mjs` supplies the parts of Three.js's object model the loader
 * touches, and no .glb file is read: the loader's model cache is populated
 * directly with stub scenes, which is the same shape GLTFLoader would hand it.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { THREE_STUB } from './three-stub.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendJsDirectory = path.join(testDirectory, '..', 'frontend', 'js');

// config.js reads `window.location` as soon as it is evaluated, so a minimal
// browser environment has to exist before any of these modules are imported.
globalThis.window = { location: { search: '', hostname: 'localhost' } };

const { PieceLoader } = await import(
  pathToFileURL(path.join(frontendJsDirectory, 'piece-loader.js')).href
);
const { PIECE_COLOURS } = await import(
  pathToFileURL(path.join(frontendJsDirectory, 'config.js')).href
);

let passedCheckCount = 0;
function reportPass(description) {
  passedCheckCount += 1;
  console.log(`  ok  ${description}`);
}

/* ------------------------------------------------------------------------ *
 * Scaffolding
 * ------------------------------------------------------------------------ */

/** GLTFLoader is constructed but never used, because no file is ever loaded. */
class UnusedGltfLoader {}

/**
 * Build a stand-in for a loaded .glb scene.
 *
 * @param {Array<{name: string, materialName: string}>} meshSpecs
 */
function createLoadedScene(meshSpecs) {
  const loadedScene = new THREE_STUB.Group();
  for (const meshSpec of meshSpecs) {
    const material = new THREE_STUB.MeshStandardMaterial({ color: 0xe8e0d0 });
    material.name = meshSpec.materialName;
    const mesh = new THREE_STUB.Mesh({}, material);
    mesh.name = meshSpec.name;
    loadedScene.add(mesh);
  }
  return loadedScene;
}

/** A loader whose cache already holds one model, tinted and ready. */
function createLoaderFor(meshSpecs) {
  const pieceLoader = new PieceLoader({
    THREE: THREE_STUB,
    GLTFLoader: UnusedGltfLoader,
  });
  pieceLoader.loadedModelsByType.set('q', createLoadedScene(meshSpecs));
  pieceLoader.buildTintedTemplates();
  return pieceLoader;
}

/** Every mesh in a piece, in the order it was added. */
function meshesOf(pieceObject) {
  const meshes = [];
  pieceObject.traverse((child) => {
    if (child.isMesh) {
      meshes.push(child);
    }
  });
  return meshes;
}

/** The colours a piece's meshes actually ended up with. */
function colourHexesOf(pieceLoader, pieceColour) {
  return meshesOf(pieceLoader.createPiece('q', pieceColour)).map((mesh) =>
    mesh.material.color.getHex()
  );
}

/** The mesh layout the extraction script writes. */
const IMPORTED_SET_MESHES = [
  { name: 'body', materialName: 'ChessPieceBody' },
  { name: 'accent', materialName: 'ChessPieceAccent' },
];

/** The mesh layout trimesh gives the generated set: one mesh, nothing named. */
const GENERATED_SET_MESHES = [{ name: 'geometry_0', materialName: '' }];

/* ------------------------------------------------------------------------ *
 * The two model sets
 * ------------------------------------------------------------------------ */

function testImportedSetGetsTwoTones() {
  console.log('\ntwo-tone tinting (imported set)');
  const pieceLoader = createLoaderFor(IMPORTED_SET_MESHES);

  for (const pieceColour of ['w', 'b']) {
    const [bodyHex, accentHex] = colourHexesOf(pieceLoader, pieceColour);
    assert.equal(bodyHex, PIECE_COLOURS[pieceColour].body);
    assert.equal(accentHex, PIECE_COLOURS[pieceColour].accent);
    assert.notEqual(bodyHex, accentHex, 'body and accent must be distinguishable');
  }
  reportPass('body and accent meshes take their own colour on both sides');
}

function testGeneratedSetStillWorks() {
  console.log('\nsingle-mesh tinting (generated set)');
  const pieceLoader = createLoaderFor(GENERATED_SET_MESHES);

  for (const pieceColour of ['w', 'b']) {
    const colourHexes = colourHexesOf(pieceLoader, pieceColour);
    assert.equal(colourHexes.length, 1);
    assert.equal(
      colourHexes[0],
      PIECE_COLOURS[pieceColour].body,
      'a model with no accent must fall back to the body colour, not go untinted'
    );
  }
  reportPass('a single unnamed mesh is treated as body, so the generated set is unaffected');
}

/* ------------------------------------------------------------------------ *
 * How an accent is recognised
 * ------------------------------------------------------------------------ */

function testAccentIsFoundByEitherName() {
  console.log('\naccent detection');

  // A glTF optimiser may rename or drop nodes while keeping materials, or the
  // reverse, so either signal on its own has to be enough.
  const byMeshNameOnly = createLoaderFor([
    { name: 'body', materialName: '' },
    { name: 'accent', materialName: '' },
  ]);
  assert.equal(colourHexesOf(byMeshNameOnly, 'w')[1], PIECE_COLOURS.w.accent);
  reportPass('an accent is recognised by mesh name alone');

  const byMaterialNameOnly = createLoaderFor([
    { name: '', materialName: 'ChessPieceBody' },
    { name: '', materialName: 'ChessPieceAccent' },
  ]);
  assert.equal(colourHexesOf(byMaterialNameOnly, 'w')[1], PIECE_COLOURS.w.accent);
  reportPass('an accent is recognised by material name alone');

  const unrecognised = createLoaderFor([
    { name: 'Circle_white_0', materialName: 'white' },
    { name: 'Circle_Coppper_0', materialName: 'Coppper' },
  ]);
  const unrecognisedHexes = colourHexesOf(unrecognised, 'w');
  assert.deepEqual(
    unrecognisedHexes,
    [PIECE_COLOURS.w.body, PIECE_COLOURS.w.body],
    'meshes that name no accent must all be tinted as body'
  );
  reportPass('a model using unrelated names degrades to a single tone rather than to black');
}

/* ------------------------------------------------------------------------ *
 * The failure modes that do not throw
 * ------------------------------------------------------------------------ */

function testTemplatesDoNotShareMaterials() {
  console.log('\nmaterial isolation');
  const pieceLoader = createLoaderFor(IMPORTED_SET_MESHES);

  const whiteMaterials = meshesOf(pieceLoader.createPiece('q', 'w')).map((m) => m.material);
  const blackMaterials = meshesOf(pieceLoader.createPiece('q', 'b')).map((m) => m.material);

  for (const whiteMaterial of whiteMaterials) {
    assert.ok(
      !blackMaterials.includes(whiteMaterial),
      'the two sides must not share a material object, or tinting one repaints the other'
    );
  }
  // The bug this guards against is not the shared reference itself but its
  // effect, so assert the effect too.
  assert.notEqual(colourHexesOf(pieceLoader, 'w')[0], colourHexesOf(pieceLoader, 'b')[0]);
  reportPass('the light and dark templates own separate materials');
}

function testBlackPiecesFaceTheOpponent() {
  console.log('\nfacing');
  const pieceLoader = createLoaderFor(IMPORTED_SET_MESHES);

  assert.equal(pieceLoader.createPiece('q', 'w').rotation.y, 0);
  assert.ok(
    Math.abs(pieceLoader.createPiece('q', 'b').rotation.y - Math.PI) < 1e-9,
    'black pieces must be turned to face down the board'
  );
  reportPass('black pieces are rotated 180 degrees and white pieces are not');
}

function testMalformedPaletteFailsLoudly() {
  console.log('\npalette validation');

  // The shape PIECE_COLOURS had before two-tone tinting. Left unchecked it
  // makes every lookup undefined, and setHex(undefined) paints the set black
  // without any error at all.
  const originalWhitePalette = PIECE_COLOURS.w;
  try {
    PIECE_COLOURS.w = 0xf2ead8;
    assert.throws(
      () => createLoaderFor(IMPORTED_SET_MESHES),
      /PIECE_COLOURS\.w must be an object/,
      'a single-hex palette must be rejected with an explanation'
    );
  } finally {
    PIECE_COLOURS.w = originalWhitePalette;
  }
  reportPass('an out-of-date single-hex palette throws instead of silently painting black');
}

/* ------------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------------ */

try {
  testImportedSetGetsTwoTones();
  testGeneratedSetStillWorks();
  testAccentIsFoundByEitherName();
  testTemplatesDoNotShareMaterials();
  testBlackPiecesFaceTheOpponent();
  testMalformedPaletteFailsLoudly();
  console.log(`\nAll ${passedCheckCount} piece-tinting checks passed.`);
} catch (testError) {
  console.error('\nPIECE TINTING TEST FAILED:', testError.message);
  process.exitCode = 1;
}
