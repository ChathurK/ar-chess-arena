# Notes for the technical report

Raw material for the four-page report, organised roughly in the order the
marking scheme reads. Nothing here is finished prose — it is the set of facts,
decisions and numbers that the report should be built from, so that writing it
is a matter of selection rather than recall.

Assessment weighting to write towards: Technical Implementation (8), UX &
Interaction (5), Documentation & Troubleshooting (5), Problem Definition &
Innovation (4), Testing & Evaluation (3).

---

## 1. Problem definition and innovation (4 marks)

**The problem.** Chess is taught and practised on a flat screen. A beginner
learning mating patterns has to translate a 2D diagram into the spatial
relationships that actually make the pattern work, and two people who want to
play together over distance lose the physical board entirely.

**What this project does about it.** Two modes, each answering one half:

* Puzzle Mode puts a checkmate position on a real table in front of the
  learner, at real scale, viewable from any angle by moving the phone.
* Duel Mode gives two remote players a physical board each, kept in step with
  each other, so the game is shared even when the room is not.

**Where the innovation lies.** Not in AR chess as an idea — AR chess apps
exist. Three things are worth claiming:

1. It is entirely browser-based. No install, no app store, no native SDK: a URL
   and a camera. That is a genuine constraint and it shaped every technical
   choice below.
2. It demonstrates both tracking paradigms in one coherent product rather than
   bolting on a second mode to satisfy a checklist — marker tracking suits a
   fixed puzzle on a printed sheet, spatial tracking suits a full-size board on
   a real table, and each mode uses the one that actually fits it.
3. The multiplayer model is honest about its limits (see §4, shared space) and
   designs around them rather than pretending to a capability the platform does
   not have.

---

## 2. Design and architecture (Technical Implementation, 8 marks)

**Layers.**

* Static frontend (GitHub Pages) — no build step, ES modules loaded directly.
* Stateless-ish relay backend (Render) — Express + Socket.IO, in-memory rooms.
* Shared frontend modules used identically by both AR modes.

**The shared-module design is the point worth explaining.** The two modes use
different AR stacks — A-Frame/AR.js is a declarative HTML framework, WebXR via
Three.js is an imperative API — but the *chess* is identical. Board geometry,
piece loading, move animation, highlighting and tap-to-square picking all live
in modules that take the Three.js namespace as a parameter rather than
importing it:

```js
export function createBoard(THREE) { … }
```

That single decision is what lets Puzzle Mode pass in `AFRAME.THREE` and Duel
Mode pass in its own imported copy, without ever mixing objects from two
different Three.js builds in one scene graph — a mistake that produces
confusing, hard-to-diagnose rendering failures.

**Coordinate convention.** One board unit equals one square; the board spans
−4…+4 on X and Z; the playing surface is exactly y = 0. Each mode then applies
a single scale factor (0.16 for the marker, ~0.045 m/square for the table).
Because the origin of every piece model is the centre of its base, placing a
piece is one `position.set` with no offsets to remember.

**Server-authoritative model.** Clients send intents, the server broadcasts
facts, every broadcast carries the full FEN. Discussed further in §4.

---

## 3. Implementation details worth citing

* **Six models, twelve pieces.** Each `.glb` is exported in a neutral colour and
  tinted at runtime, halving download size. Cloning shares materials, so all
  sixteen white pawns cost one material between them.
* **Two tones per piece, still six files.** Each imported model is split into a
  `body` mesh and an `accent` mesh, tinted from separate colours, so the metal
  rings and finials read as metal rather than as painted wood. Only the colour
  is overridden; the metalness and roughness the model was authored with are
  left alone. Anything not identifiable as an accent is treated as body, which
  is what lets the single-mesh self-authored set run through the same code with
  no special case.
* **Model sizes, imported set (in use).** pawn 17.8 KB, rook 21.2 KB, knight
  30.3 KB, bishop 19.3 KB, queen 30.9 KB, king 26.4 KB — 146 KB for the set,
  7,638 triangles, 35,328 for a full 32-piece board.
* **Model sizes, self-authored set (fallback).** pawn 27.7 KB, rook 13.6 KB,
  knight 9.2 KB, bishop 26.3 KB, queen 25.7 KB, king 19.7 KB — 122 KB, 6,588
  triangles, 39,680 for a full board. Face counts range from 460 (knight) to
  1520 (pawn).
* **Audio is synthesised, not sampled.** A filtered noise burst plus a low
  triangle wave reads as a wooden knock; the capture sound is the same idea
  lower and longer. No audio files ship, so there is no licence to document.
* **Highlight layering.** Last move → legal target → selection → king in check,
  weakest first, so the strongest meaning always wins a square.
* **Animation.** Pieces travel along a half-sine arc (`sin(t·π)`) with cubic
  ease-in-out on the horizontal component, so they lift and land cleanly rather
  than sliding through each other.

---

## 4. Challenges and solutions (required section — the strongest material)

### 4.1 Two phones cannot share one physical board

*Challenge.* The obvious reading of "two-player AR chess" is one board on one
table seen by two devices. That requires both devices to agree on a single
real-world coordinate system.

*Investigation.* No browser API provides this. It needs a cloud anchor service
(Google Cloud Anchors, Azure Spatial Anchors), all of which are native SDKs
with accounts, keys and quotas — incompatible with a browser-only,
zero-install brief.

*Solution.* Redefine what is shared. Each player anchors their own board in
their own space and the *game state* synchronises, the way an online quiz shares
questions rather than a room. The limitation is stated in the interface, not
hidden.

*Why this is the right answer, not a compromise.* It also removes the
requirement that both players be in the same place, which is what makes the
mode useful at all.

### 4.2 A pure relay silently desynchronises

*Challenge.* The simplest multiplayer design forwards each client's move to the
other. It breaks in two ordinary, non-adversarial ways: a dropped or duplicated
message leaves the two boards showing different positions with nothing able to
detect it, and two simultaneous taps have no arbiter.

*Solution.* Each room owns a `chess.js` instance on the server. A client sends
`{from, to}` and nothing changes locally; the server checks membership, then
turn, then legality, applies the move, and broadcasts the result to both
players through one code path. Promotion is decided server-side too — the
client is never trusted to declare it.

*Belt and braces.* Every broadcast includes the full FEN. After applying a move
the client compares its own FEN with the server's and, on any mismatch, discards
its position and rebuilds from the server's. A visible jump is far better than
two players quietly playing different games.

*Evidence it works.* `tests/relay-integration-test.mjs` starts the real server,
connects two real Socket.IO clients and asserts that out-of-turn moves,
illegal moves and malformed payloads are all refused, that both clients receive
byte-identical broadcasts, that Fool's Mate is detected as checkmate, and that
an abandoned room is cleaned up rather than leaked.

### 4.3 Puzzle correctness cannot be trusted to memory

*Challenge.* A "mate in 2" that is really mate in 1, or that has a second
solution, or that lets the defender escape, is an embarrassing and very visible
bug in a live demo — and reviewing it by eye is exactly the kind of check that
looks fine until someone tries the position.

*Solution.* Positions are generated and proved by search, not written down.
`scripts/find_puzzles.mjs` runs an AND/OR forced-mate search (the attacker needs
one move that works; the defender must have no reply that escapes; stalemate
counts as a failure for the attacker) and keeps only positions that are a forced
mate in exactly N, are not mate in fewer, and have exactly one key move.
`tests/verify-puzzles.mjs` re-proves all of this against the data file the
browser actually loads, on every test run.

*Result.* Three verified puzzles: "The Queen's Escort" (K+Q, key move Ke6),
"Rook Ladder" (K+R+R, Ra2+), "Cornered" (K+R+R vs K+P, Kf7).

### 4.4 A downloaded 3D asset is not a usable 3D asset

*Background.* The project first solved its asset problem by avoiding it. An
earlier iteration had lost real time sourcing models — downloads behind
authentication, unclear licences, inconsistent scale and orientation — so the
pieces were generated instead: chess pieces are almost all solids of
revolution, and a 2D silhouette spun around the vertical axis with `trimesh`
produces presentable geometry with no licensing risk at all. That set still
ships, and remains the fallback.

*Challenge.* A better-looking CC-BY set was then found, and none of it was
usable as downloaded. The file is not six models; it is one 9.3 MB scene
holding a complete set-up board — 32 pre-placed pieces plus the board, 309,796
triangles, with UV coordinates on all 172,808 vertices and no textures to
sample with them. Dropped in as-is it would put 308,000 triangles on screen for
a full board, roughly eight times what the generated set costs, on a phone
already decoding a camera feed and running spatial tracking. The included board
is unusable for a different reason: all 32 light squares are a single
64-triangle mesh sharing one material, so per-square highlighting — selection,
legal moves, check — is impossible without rebuilding it, which is what the
procedural board already does.

*Solution.* A second pipeline, `scripts/extract_chess_pieces.py`, that turns the
download into something this project can serve. It identifies all 32 pieces by
where they stand on the board rather than by name — the source names are
modelling-tool leftovers like `Circle.027`, but a set-up chess board identifies
every piece by square, which is a property of chess and not of one file — keeps
one instance of each type, splits body from accent, decimates to a face budget,
strips the dead UV channel, and rescales the whole set by one factor so the
artist's proportions survive.

*The bug worth reporting.* Naive decimation silently decapitated the pawn. These
pieces are not single surfaces: each is a stack of separate closed shells, body
segments alternating with metal rings, and a pawn body alone is seven of them.
Handed the whole stack, quadric decimation spends the budget on the largest
shells and deletes the small ones outright — the pawn came out 30% shorter with
its head simply gone. Decimating per connected component fixes it. A second,
subtler case: the pawn's open-bottomed base has a 52-edge rim, and quadric
decimation pins boundary edges, so asked for 141 faces it returned 637 every
time. Capping each rim before decimating releases it — about 8,000 triangles
across sixteen pawns.

*Result.* 309,796 triangles to 7,638 for the six models; a full board from
308,208 to 35,328, which is below what the generated set costs. 9.3 MB to
146 KB.

*Verification.* Both pipelines reload every exported model and check it for NaN
vertices, zero faces, the requested height, a base sitting exactly on y = 0, and
a width that fits inside one square, before it is wired into the frontend. The
height check is what caught the decapitated pawn. The extraction script adds two
checks the imported path needs: that the body/accent split survived the round
trip, and that the UV channel really is gone.

*Licensing, which generated assets do not have.* CC-BY is satisfied by crediting
the author wherever the work is used, not by noting it in a repository. The
script reads the licence and author out of the source file's own metadata rather
than from a web page that may since have been edited, and writes an
`ATTRIBUTION.md` beside the models. The credit appears in the README, on the
landing page every visitor passes through, and here.

### 4.5 A-Frame and Three.js each bundle their own Three.js

*Challenge.* Puzzle Mode runs inside A-Frame, which ships its own Three.js
build. Duel Mode imports Three.js directly. Sharing code between them naively
means objects created by one build being added to a scene managed by the other,
which fails in ways that are difficult to trace back to their cause.

*Solution.* No shared module imports Three.js. Every one of them takes the
caller's namespace as a parameter. Each page therefore uses exactly one copy of
the library, and the shared code genuinely is shared rather than duplicated.

### 4.6 Taps in a WebXR DOM overlay hit the board as well as the button

*Challenge.* With `dom-overlay` active, tapping a heads-up-display button also
generates an XR `select` event, so pressing "Place board" was simultaneously
read as a tap on the board behind it.

*Solution.* Cancel `beforexrselect` on the overlay root — the event the
specification provides for exactly this, and one that is easy to miss. Outside
XR, the equivalent guard is ignoring pointer events whose target lies inside the
overlay.

### 4.7 En passant, castling and promotion break naive move rendering

*Challenge.* "Move the piece from A to B, delete anything on B" is wrong for
three legal moves: en passant captures a pawn that is not on the destination
square, castling moves two pieces, and promotion replaces the piece that
arrives.

*Solution.* `board-view.js` resolves each case explicitly — the captured square
is recomputed for en passant, the rook's journey is derived from the king
travelling two files, and the pawn object is swapped for a queen in the slide
animation's completion callback. `tests/board-logic-test.mjs` exercises all
three headlessly, with a stub Three.js, so they are verified without a browser.

---

## 5. Testing and evaluation (3 marks)

| Test | What it proves |
|---|---|
| `tests/verify-puzzles.mjs` | Every shipped puzzle is a forced mate in exactly its advertised number of moves, with a unique key move. |
| `tests/relay-integration-test.mjs` | The real server, over real sockets: room lifecycle, turn enforcement, illegal and malformed move rejection, identical broadcasts, checkmate detection, disconnect cleanup. |
| `tests/board-logic-test.mjs` | Square ⇄ 3D mapping, and correct rendering of captures, en passant, castling and promotion. |
| `tests/frontend-static-check.mjs` | Every module import, asset path and element id referenced by the scripts actually exists — the class of typo that only shows up at runtime. |
| `scripts/generate_chess_pieces.py` | Self-verifying: each exported model is reloaded and checked before it is trusted. |

**Manual test matrix to fill in during evaluation** — device, browser, mode,
outcome, notes. Worth recording: marker detection distance, time to first hit
test, frame rate with the full 32-piece board, and end-to-end move latency
between two phones.

**Known limitations to state honestly.**

* Duel Mode board placement needs WebXR hit-testing (in practice, Chrome on
  Android with ARCore). A non-AR view is provided as a fallback.
* Rooms live in memory; a backend restart ends any game in progress.
* A free-tier backend sleeps when idle and takes up to a minute to wake.
* Pawn promotion is always to a queen.
* Marker tracking degrades with glare, poor light, or a creased printout.

---

## 6. Demo video plan (3 minutes)

| Time | Shot |
|---|---|
| 0:00–0:20 | Landing page; state the two modes and the two tracking types. |
| 0:20–1:10 | Puzzle Mode: camera finds the marker, board appears, walk around it, tap a piece to show legal-move highlighting, play the key move, Black replies, deliver mate. |
| 1:10–1:25 | Show the puzzle verification script running — correctness is proved, not asserted. |
| 1:25–2:35 | Duel Mode on two phones side by side: create a room, join with the code, each places their own board, a few moves syncing live, a capture, a check, and a checkmate. |
| 2:35–3:00 | Show `/status` on the backend and the relay test passing; close on the shared-module architecture diagram. |
