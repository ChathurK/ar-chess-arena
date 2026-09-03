/**
 * frontend-static-check.mjs
 * =========================
 * Catches the class of frontend mistake that no unit test finds and no
 * compiler warns about, because a static site has neither: a renamed element
 * id the script still looks for, an import path that lost a folder, a model
 * file that never made it into the deploy, a CDN URL quietly pointing at a
 * moving target.
 *
 * Every one of these fails at runtime, on a phone, usually in front of an
 * audience. Run with `node tests/frontend-static-check.mjs`.
 *
 * Checks performed:
 *   1. every relative import between the frontend modules resolves to a file;
 *   2. every element id a script looks up exists in the page that loads it;
 *   3. every local href/src in the HTML points at a file that exists;
 *   4. every CSS class used in the HTML is defined in the stylesheet;
 *   5. every piece model named in config.js is actually present;
 *   6. every third-party URL is pinned to an exact version.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.join(testDirectory, '..', 'frontend');

let passedCheckCount = 0;
const problems = [];

function reportPass(description) {
  passedCheckCount += 1;
  console.log(`  ok  ${description}`);
}

function reportProblem(description) {
  problems.push(description);
  console.log(`  FAIL  ${description}`);
}

const readTextFile = (relativePath) =>
  fs.readFile(path.join(frontendDirectory, relativePath), 'utf8');

const fileExists = async (relativePath) => {
  try {
    await fs.access(path.join(frontendDirectory, relativePath));
    return true;
  } catch {
    return false;
  }
};

/** Which script drives which page — used to check element ids against markup. */
const PAGE_SCRIPTS = [
  { page: 'puzzle.html', script: 'js/puzzle-scene.js' },
  { page: 'duel.html', script: 'js/duel-scene.js' },
];

const MODULE_FILES = [
  'js/config.js',
  'js/chess-engine.js',
  'js/board-builder.js',
  'js/piece-loader.js',
  'js/board-view.js',
  'js/puzzles.js',
  'js/puzzle-scene.js',
  'js/duel-scene.js',
  'js/audio.js',
];

const HTML_FILES = ['index.html', 'puzzle.html', 'duel.html', 'assets/markers/marker.html'];

/* ------------------------------------------------------------------------ *
 * 1. Module imports resolve
 * ------------------------------------------------------------------------ */

async function checkModuleImportsResolve() {
  console.log('\nmodule imports');
  let brokenImportCount = 0;

  for (const moduleFile of MODULE_FILES) {
    const source = await readTextFile(moduleFile);
    const importMatches = source.matchAll(/from\s+['"](\.[^'"]+)['"]/g);

    for (const importMatch of importMatches) {
      const importedPath = importMatch[1];
      const resolvedPath = path.posix.join(path.posix.dirname(moduleFile), importedPath);
      if (!(await fileExists(resolvedPath))) {
        reportProblem(`${moduleFile} imports "${importedPath}", which does not exist`);
        brokenImportCount += 1;
      }
    }
  }

  if (brokenImportCount === 0) {
    reportPass(`every relative import across ${MODULE_FILES.length} modules resolves to a file`);
  }
}

/* ------------------------------------------------------------------------ *
 * 2. Element ids exist in the markup
 * ------------------------------------------------------------------------ */

async function checkElementIdsExist() {
  console.log('\nelement ids referenced by scripts');

  for (const { page, script } of PAGE_SCRIPTS) {
    const markup = await readTextFile(page);
    const source = await readTextFile(script);

    const referencedIds = new Set(
      Array.from(source.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g), (match) => match[1])
    );

    const missingIds = Array.from(referencedIds).filter(
      (elementId) => !new RegExp(`id\\s*=\\s*["']${elementId}["']`).test(markup)
    );

    if (missingIds.length > 0) {
      reportProblem(`${script} looks for ids that ${page} does not define: ${missingIds.join(', ')}`);
    } else {
      reportPass(`all ${referencedIds.size} ids used by ${script} exist in ${page}`);
    }
  }
}

/* ------------------------------------------------------------------------ *
 * 3. Local links point at real files
 * ------------------------------------------------------------------------ */

async function checkLocalLinks() {
  console.log('\nlocal links and script tags');
  let brokenLinkCount = 0;

  for (const htmlFile of HTML_FILES) {
    const markup = await readTextFile(htmlFile);
    const references = Array.from(
      markup.matchAll(/(?:href|src)\s*=\s*["'](\.[^"']+)["']/g),
      (match) => match[1]
    );

    for (const reference of references) {
      const resolvedPath = path.posix.join(path.posix.dirname(htmlFile), reference.split('?')[0]);
      if (!(await fileExists(resolvedPath))) {
        reportProblem(`${htmlFile} links to "${reference}", which does not exist`);
        brokenLinkCount += 1;
      }
    }
  }

  if (brokenLinkCount === 0) {
    reportPass('every local href and src in the HTML resolves to a file');
  }
}

/* ------------------------------------------------------------------------ *
 * 4. CSS classes used in the markup are defined
 * ------------------------------------------------------------------------ */

async function checkCssClassesAreDefined() {
  console.log('\nCSS classes');
  const stylesheet = await readTextFile('css/style.css');

  const undefinedClasses = new Set();
  for (const htmlFile of HTML_FILES) {
    // marker.html carries its own inline styles and does not use the shared
    // stylesheet, so it is skipped rather than reported as broken.
    if (htmlFile.includes('markers/')) {
      continue;
    }
    const markup = await readTextFile(htmlFile);
    for (const classAttribute of markup.matchAll(/class\s*=\s*["']([^"']+)["']/g)) {
      for (const className of classAttribute[1].split(/\s+/).filter(Boolean)) {
        if (!stylesheet.includes(`.${className}`)) {
          undefinedClasses.add(`${className} (in ${htmlFile})`);
        }
      }
    }
  }

  if (undefinedClasses.size > 0) {
    reportProblem(`classes used in the markup but absent from style.css: ${Array.from(undefinedClasses).join(', ')}`);
  } else {
    reportPass('every class used in the markup is defined in style.css');
  }
}

/* ------------------------------------------------------------------------ *
 * 5. The 3D models named in config.js are present
 * ------------------------------------------------------------------------ */

async function checkModelFilesArePresent() {
  console.log('\n3D model files');
  const configSource = await readTextFile('js/config.js');

  const modelFileNames = Array.from(
    configSource.matchAll(/^\s*[prnbqk]:\s*'([^']+\.glb)'/gm),
    (match) => match[1]
  );
  assert.equal(modelFileNames.length, 6, 'config.js should name exactly six piece models');

  let missingModelCount = 0;
  for (const modelFileName of modelFileNames) {
    const modelPath = `assets/models/${modelFileName}`;
    if (!(await fileExists(modelPath))) {
      reportProblem(`config.js names ${modelFileName}, which is not in assets/models/`);
      missingModelCount += 1;
      continue;
    }
    const modelStats = await fs.stat(path.join(frontendDirectory, modelPath));
    if (modelStats.size < 1024) {
      reportProblem(`${modelFileName} is suspiciously small (${modelStats.size} bytes)`);
      missingModelCount += 1;
    }
  }

  if (missingModelCount === 0) {
    reportPass(`all six piece models are present and plausibly sized`);
  }
}

/* ------------------------------------------------------------------------ *
 * 6. Third-party URLs are pinned
 * ------------------------------------------------------------------------ */

async function checkExternalUrlsArePinned() {
  console.log('\nthird-party URLs');

  const filesToScan = [...HTML_FILES, ...MODULE_FILES];
  const externalUrls = new Set();

  for (const fileToScan of filesToScan) {
    const source = await readTextFile(fileToScan);
    for (const urlMatch of source.matchAll(/https:\/\/[^\s"'`)]+/g)) {
      externalUrls.add(urlMatch[0]);
    }
  }

  // A URL that resolves to "whatever is newest" turns a working deployment
  // into one that can break with no change of its own.
  const movingTargetPatterns = [/@latest/, /\/master\//, /\/main\//, /@\^/, /@~/];
  const librariesLoadedFromCdn = Array.from(externalUrls).filter((url) =>
    /(jsdelivr|unpkg|cdn\.socket\.io|aframe\.io|githack)/.test(url)
  );

  const unpinnedUrls = librariesLoadedFromCdn.filter((url) =>
    movingTargetPatterns.some((pattern) => pattern.test(url))
  );

  if (unpinnedUrls.length > 0) {
    reportProblem(`these library URLs are not pinned to a fixed version: ${unpinnedUrls.join(', ')}`);
  } else {
    reportPass(`all ${librariesLoadedFromCdn.length} library URLs are pinned to exact versions`);
  }

  // Socket.IO's client and server must agree on major.minor or the handshake
  // fails with an unhelpful error.
  const socketIoClientUrl = Array.from(externalUrls).find((url) => url.includes('cdn.socket.io'));
  assert.ok(socketIoClientUrl, 'duel.html should load the Socket.IO browser client');
  const clientVersion = socketIoClientUrl.match(/socket\.io\/(\d+\.\d+)\./);

  const backendPackage = JSON.parse(
    await fs.readFile(path.join(testDirectory, '..', 'backend', 'package.json'), 'utf8')
  );
  const serverVersion = backendPackage.dependencies['socket.io'].match(/^(\d+\.\d+)/);

  if (clientVersion && serverVersion && clientVersion[1] === serverVersion[1]) {
    reportPass(`the Socket.IO client and server agree on version ${clientVersion[1]}.x`);
  } else {
    reportProblem(
      `Socket.IO version mismatch: client ${clientVersion && clientVersion[1]}, ` +
        `server ${serverVersion && serverVersion[1]}`
    );
  }
}

/* ------------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------------ */

await checkModuleImportsResolve();
await checkElementIdsExist();
await checkLocalLinks();
await checkCssClassesAreDefined();
await checkModelFilesArePresent();
await checkExternalUrlsArePinned();

if (problems.length > 0) {
  console.error(`\n${problems.length} static check(s) FAILED.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${passedCheckCount} static checks passed.`);
}
