# AR Chess Arena

A browser-based AR chess project built for Virtual and Augmented Reality. It has two modes, each showcasing a different tracking type.

| Mode | Tracking | What it is |
|---|---|---|
| **Puzzle Mode** | Marker-based (A-Frame + AR.js) | Point the camera at a printed marker; a board appears on it, set up in a verified checkmate puzzle. Solve it inside a move budget. |
| **Duel Mode** | Markerless (Three.js + WebXR hit-test) | Place a board on a real surface with spatial tracking, then play a full game against another person on their own device, synchronised live over Socket.IO. |

---

## How the assignment requirements are met

| Requirement | Where it is satisfied |
|---|---|
| Browser-based WebXR/WebAR, mobile-compatible | `frontend/puzzle.html` (AR.js) and `frontend/duel.html` (WebXR Device API) |
| Approved framework | A-Frame 1.5.0 + AR.js 3.4.8, and Three.js 0.185.1 |
| At least two 3D models, web-optimised | Six procedurally generated `.glb` pieces, 9–28 KB each — `scripts/generate_chess_pieces.py` |
| XR/AR user interface | Heads-up display over the camera feed in both modes: status, move budget, room code, board size, sound |
| Animation | Pieces arc between squares; captured pieces shrink away — `frontend/js/board-view.js` |
| Lighting | Hemisphere fill plus a directional key, tuned for a bright camera feed — `board-builder.js` |
| Audio | Synthesised with the Web Audio API — no audio files, no licensing questions — `frontend/js/audio.js` |
| Marker-based tracking | Puzzle Mode, Hiro marker via AR.js |
| Markerless tracking | Duel Mode, WebXR `hit-test` against real surfaces |
| **Advanced feature — Option B** (complex interaction, multi-step state) | The two-player duel: turn-based state machine, server-authoritative legal-move validation, check/checkmate/stalemate detection, disconnect handling |

Option A (a live external data source altering the 3D content) is **not** used;
Option B alone satisfies the requirement. A database layer remains a clean
optional extension — see [Extending it](#extending-it).

---

## Project structure

```
ar-chess-arena/
├── frontend/                     static site → GitHub Pages
│   ├── index.html                landing page
│   ├── puzzle.html               marker-based AR
│   ├── duel.html                 markerless AR + multiplayer
│   ├── css/style.css
│   ├── js/
│   │   ├── config.js             every tunable value and the backend URL
│   │   ├── chess-engine.js       wrapper around chess.js
│   │   ├── board-builder.js      procedural board + square ⇄ 3D mapping
│   │   ├── piece-loader.js       loads the six .glb models, tints them
│   │   ├── board-view.js         the shared 3D board: animation, highlights, picking
│   │   ├── audio.js              synthesised sound effects
│   │   ├── puzzles.js            verified puzzle positions
│   │   ├── puzzle-scene.js       Puzzle Mode glue
│   │   └── duel-scene.js         Duel Mode glue (WebXR + Socket.IO)
│   └── assets/
│       ├── models/               pawn/rook/knight/bishop/queen/king .glb
│       └── markers/              marker.html (printable) + notes
├── backend/                      Socket.IO relay → Render
│   ├── server.js                 Express + HTTP server + Socket.IO
│   ├── socket/chessRelay.js      rooms, authoritative validation, the event contract
│   └── utils/roomCodes.js        short unambiguous room codes
├── scripts/
│   ├── generate_chess_pieces.py  procedural model generation (trimesh)
│   └── find_puzzles.mjs          searches for provably correct puzzles
├── tests/
│   ├── verify-puzzles.mjs        re-proves every shipped puzzle
│   ├── board-logic-test.mjs      board mapping and move rendering, headless
│   ├── frontend-static-check.mjs catches broken imports, paths and element ids
│   └── relay-integration-test.mjs real server, real sockets, real games
└── docs/                         notes for the technical report
```

---

## Running it locally

### 1. The backend

```bash
cd backend
npm install
npm start          # listens on http://localhost:3000
```

Check it is alive at `http://localhost:3000/` and see live rooms at
`http://localhost:3000/status`.

### 2. The frontend

It is a plain static site — any static server will do:

```bash
cd frontend
npx serve .        # or: python3 -m http.server 8080
```

Open `http://localhost:8080`. On `localhost` the frontend automatically points
at `http://localhost:3000` for the relay, so nothing has to be configured.

Duel Mode's **Play without AR** button lets you drive the whole two-player flow
from two browser windows on a laptop, which is by far the fastest way to test
game logic.

### 3. Testing on a phone

Camera access and WebXR both require HTTPS, so a phone cannot use
`http://<your-laptop-ip>:8080`. Tunnel it:

```bash
cloudflared tunnel --url http://localhost:8080
```

Open the `https://…trycloudflare.com` URL it prints on the phone.

Because the tunnel's hostname is neither `localhost` nor the deployed site, the
frontend falls back to the **deployed** relay URL. Two ways round that:

* deploy the backend first and let the tunnelled frontend use it (simplest), or
* tunnel the backend too and pass it explicitly:
  `https://…trycloudflare.com/duel.html?server=https://…-backend.trycloudflare.com`

The `?server=` override works on any page and is the quickest way to point a
build at a different relay without editing code.

### 4. The tests

```bash
npm install        # in the project root, for the tooling
npm test           # puzzles + relay
node tests/board-logic-test.mjs
node tests/frontend-static-check.mjs
```

---

## Deploying

### Backend → Render (free web service)

| Setting | Value |
|---|---|
| Root directory | `backend` |
| Build command | `npm install` |
| Start command | `npm start` |
| Environment | `ALLOWED_ORIGINS=https://<your-username>.github.io` |

Render's standard web services proxy WebSockets, so Socket.IO needs no special
configuration. A free instance sleeps after inactivity and takes 30–60 seconds
to wake — the lobby says so rather than showing a bare error.

### Frontend → GitHub Pages

1. Set `DEPLOYED_SOCKET_SERVER_URL` in `frontend/js/config.js` to the Render URL.
2. Push, then enable Pages for the repository, serving from `/frontend`.
3. Set `ALLOWED_ORIGINS` on Render to the resulting Pages origin.

> `https://` is enough — the Socket.IO client upgrades to `wss://` itself.

---

## The Socket.IO event contract

The server is authoritative. Clients send **intents**; the server broadcasts
**facts**. Every broadcast carries the full FEN, so a client that has drifted
out of step can resynchronise from any single message.

**Client → server**

| Event | Payload | Behaviour |
|---|---|---|
| `create-room` | — | Creates a room with a fresh game; the creator plays White. Replies `room-created { code, yourColour }`. |
| `join-room` | `{ code }` | Joins as Black if there is a free seat. Both players then receive `game-start`. Otherwise `join-failed { reason }` to the joiner only. |
| `make-move` | `{ code, from, to }` | Checked for membership, turn and legality, then applied to the room's own `chess.js` instance and broadcast to both. Otherwise `invalid-move { reason }` to the sender only. |
| `leave-room` | — | Ends the game and notifies the opponent. |

**Server → client**

| Event | Payload |
|---|---|
| `room-created` | `{ code, yourColour }` |
| `game-start` | `{ code, yourColour, fen, turn, isCheck, isCheckmate, isDraw, isStalemate, isGameOver }` |
| `move-made` | `{ from, to, piece, colour, captured, promotion, san, …position }` |
| `invalid-move` | `{ reason }` |
| `join-failed` | `{ reason }` |
| `opponent-left` | `{ reason }` |

`move-made` carries `piece`, `colour` and `captured` beyond the minimum needed
to update a position: the receiving client needs them to animate the move
(which piece slid, and whether something was taken) without re-deriving them.

---

## Design decisions worth knowing

**Why the boards are not in a shared physical space.** Registering two phones
to one real-world coordinate system requires a cloud anchor service; no browser
API offers it. Duel Mode therefore shares the *game*, not the *space* — like an
online quiz — and each player anchors their own board wherever they are.

**Why the server validates every move.** A pure relay cannot tell when two
clients have drifted apart, and cannot arbitrate two simultaneous taps. Each
room owns a `chess.js` instance; the client's copy exists only to highlight
legal moves instantly while the player is choosing.

**Why the pieces are generated, not downloaded.** Sourcing usable 3D assets
means auditing licences and, in practice, hitting sites that need an account to
download. Chess pieces are solids of revolution, so generating them from a 2D
silhouette is straightforward, self-authored, and produces files small enough
(9–28 KB) to load instantly over mobile data.

**Why the puzzles are searched for, not written down.** Puzzle correctness is
easy to get subtly wrong. `scripts/find_puzzles.mjs` proves each position is a
forced mate in exactly the advertised number of moves, with a unique key move,
and `tests/verify-puzzles.mjs` re-proves it on every test run.

**Documented simplification.** Pawn promotion always produces a queen, on both
the client and the server. A promotion picker would add a UI state that
contributes nothing to the requirements being assessed.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Camera never starts | The page must be on HTTPS (or `localhost`). Check the browser's site permissions. |
| Puzzle board never appears | The marker is not being detected: keep the white border clear, avoid glare, hold 20–50 cm away. See `frontend/assets/markers/README.md`. |
| Board jitters on the marker | Normal marker noise. The smoothing attributes on `<a-marker>` damp it; raising `smoothCount` damps more at the cost of latency. |
| "Enter AR" does nothing | The device has no WebXR AR support. Chrome on Android with Google Play Services for AR is the usual requirement. Use **Play without AR** to test the rest. |
| No yellow ring in Duel Mode | Hit-testing needs texture to lock on to. Point at a patterned surface with reasonable light; blank white tables are genuinely hard. |
| Lobby stuck on "connecting" | A sleeping free-tier backend. Open the backend URL directly to wake it, then retry. |
| Joining says "no game found" | Codes are case-insensitive but expire when either player disconnects. Create a fresh one. |

---

## Extending it

`attachChessRelay` accepts an `onGameFinished` callback, already wired up in
`backend/server.js`, which receives the room code, outcome, final FEN, move
history and timings for every completed game. A MongoDB match-history or
leaderboard layer — which would additionally satisfy Option A — plugs in there
and requires no change anywhere else in the codebase.

---

## Credits and licensing

* 3D piece models: generated by this project's own script; no third-party
  assets, no attribution required.
* Sound: synthesised at runtime; no audio files are shipped.
* Libraries: A-Frame (MIT), AR.js (MIT), Three.js (MIT), chess.js (BSD-2),
  Socket.IO (MIT), Express (MIT) — all loaded from pinned versions.
