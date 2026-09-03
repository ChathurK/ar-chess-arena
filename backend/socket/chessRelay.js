/**
 * chessRelay.js
 * =============
 * The real-time half of Duel Mode: room management and SERVER-AUTHORITATIVE
 * move validation.
 *
 * WHY THE SERVER KEEPS ITS OWN CHESS ENGINE
 * -----------------------------------------
 * A naive relay would simply forward whatever move a client sends to the other
 * client. That fails in two ordinary, non-malicious ways long before anyone
 * tries to cheat:
 *
 *   • DESYNC — if the two browsers ever disagree about the position (a dropped
 *     packet, a reconnect, a bug in one client), a pure relay has no way to
 *     notice, and the two players quietly play different games;
 *   • RACE   — both players can tap at the same instant, and only a single
 *     authority can decide whose move actually happened first.
 *
 * So each room owns a chess.js instance and that instance is the truth. A
 * client sends an INTENT ("I want to move e2 to e4"); the server decides, and
 * broadcasts a FACT ("e2e4 was played, here is the resulting position"). Every
 * broadcast carries the full FEN, so a client that has drifted can resynchronise
 * from any single message.
 *
 * ROOM LIFECYCLE
 * --------------
 *   create-room → waiting (one player) → playing (two players)
 *              → removed when a player leaves, disconnects, or the room goes idle
 *
 * Rooms live in memory only. This is an intentional design choice for this phase 
 * of the project: a restart simply means players create a new room. The one clean 
 * extension point is onGameFinished — a database layer would hook in exactly there 
 * and nowhere else.
 */

const { Chess } = require('chess.js');
const { generateRoomCode, normaliseRoomCode } = require('../utils/roomCodes');

/** Rooms with no traffic for this long are collected, freeing memory. */
const IDLE_ROOM_TIMEOUT_MS = 1 * 60 * 60 * 1000; // one hour
const IDLE_SWEEP_INTERVAL_MS = 10 * 60 * 1000; // every ten minutes

/**
 * Wire the relay onto a Socket.IO server.
 *
 * @param {import('socket.io').Server} io
 * @param {object} [options]
 * @param {(summary: object) => void} [options.onGameFinished]
 *   Called once per finished game. This is the extension point for the
 *   optional match-history/leaderboard database described in the project plan:
 *   implementing it there requires no other change to this file.
 * @returns {{rooms: Map<string, object>, shutdown: () => void}}
 */
function attachChessRelay(io, options = {}) {
  /** @type {Map<string, object>} room code → room state */
  const roomsByCode = new Map();

  /* --------------------------------------------------------------------- *
   * Helpers
   * --------------------------------------------------------------------- */

  /** Everything a client needs to describe a position after a move. */
  function describePosition(room) {
    return {
      fen: room.chess.fen(),
      turn: room.chess.turn(),
      isCheck: room.chess.isCheck(),
      isCheckmate: room.chess.isCheckmate(),
      isDraw: room.chess.isDraw(),
      isStalemate: room.chess.isStalemate(),
      isGameOver: room.chess.isGameOver(),
    };
  }

  /** Which colour, if any, this socket is playing in this room. */
  function colourOfSocketInRoom(room, socketId) {
    if (room.playerSocketIds.w === socketId) {
      return 'w';
    }
    if (room.playerSocketIds.b === socketId) {
      return 'b';
    }
    return null;
  }

  /** Find the room a socket belongs to; a socket is only ever in one. */
  function findRoomForSocket(socketId) {
    for (const room of roomsByCode.values()) {
      if (colourOfSocketInRoom(room, socketId)) {
        return room;
      }
    }
    return null;
  }

  function removeRoom(room, reason) {
    roomsByCode.delete(room.code);
    console.log(`[relay] room ${room.code} removed (${reason})`);
  }

  /** Report a finished game exactly once, then close the room down. */
  function concludeGame(room, outcome) {
    if (room.status === 'finished') {
      return;
    }
    room.status = 'finished';

    if (typeof options.onGameFinished === 'function') {
      try {
        options.onGameFinished({
          code: room.code,
          outcome,
          finalFen: room.chess.fen(),
          moveHistory: room.chess.history(),
          startedAt: room.createdAt,
          finishedAt: Date.now(),
        });
      } catch (hookError) {
        // A reporting hook must never be able to break a live game.
        console.error('[relay] onGameFinished threw:', hookError);
      }
    }
  }

  /* --------------------------------------------------------------------- *
   * Connection handling
   * --------------------------------------------------------------------- */

  io.on('connection', (socket) => {
    console.log(`[relay] socket connected: ${socket.id}`);

    /* ---- create-room ------------------------------------------------- *
     * The creator always plays White, which keeps "who moves first" from
     * needing any extra negotiation. */
    socket.on('create-room', () => {
      const existingRoom = findRoomForSocket(socket.id);
      if (existingRoom) {
        socket.emit('join-failed', { reason: 'You are already in a game.' });
        return;
      }

      const code = generateRoomCode((candidate) => roomsByCode.has(candidate));
      if (!code) {
        socket.emit('join-failed', { reason: 'The server is full. Try again in a moment.' });
        return;
      }

      const room = {
        code,
        chess: new Chess(),
        playerSocketIds: { w: socket.id, b: null },
        status: 'waiting',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };
      roomsByCode.set(code, room);
      socket.join(code);

      console.log(`[relay] room ${code} created by ${socket.id}`);
      socket.emit('room-created', { code, yourColour: 'w' });
    });

    /* ---- join-room --------------------------------------------------- */
    socket.on('join-room', (payload) => {
      const code = normaliseRoomCode(payload && payload.code);
      if (!code) {
        socket.emit('join-failed', { reason: 'That is not a valid room code.' });
        return;
      }

      const room = roomsByCode.get(code);
      if (!room) {
        socket.emit('join-failed', { reason: `No game found with the code ${code}.` });
        return;
      }
      if (room.playerSocketIds.b) {
        socket.emit('join-failed', { reason: 'That game already has two players.' });
        return;
      }
      if (room.playerSocketIds.w === socket.id) {
        socket.emit('join-failed', { reason: 'You cannot join your own game twice.' });
        return;
      }

      room.playerSocketIds.b = socket.id;
      room.status = 'playing';
      room.lastActivityAt = Date.now();
      socket.join(code);

      console.log(`[relay] ${socket.id} joined room ${code}; game starting`);

      // Both players are told the game has started, each with their own
      // colour, so neither client has to work out which side it is playing.
      const position = describePosition(room);
      io.to(room.playerSocketIds.w).emit('game-start', {
        code,
        yourColour: 'w',
        ...position,
      });
      io.to(room.playerSocketIds.b).emit('game-start', {
        code,
        yourColour: 'b',
        ...position,
      });
    });

    /* ---- make-move ---------------------------------------------------- *
     * The heart of the authoritative model. Note the order of the checks:
     * membership, then turn, then legality. Each one is capable of rejecting
     * a request on its own, and none of them trusts anything the client said
     * beyond the two square names. */
    socket.on('make-move', (payload) => {
      const room = roomsByCode.get(normaliseRoomCode(payload && payload.code) || '');
      if (!room) {
        socket.emit('invalid-move', { reason: 'That game no longer exists.' });
        return;
      }

      const playerColour = colourOfSocketInRoom(room, socket.id);
      if (!playerColour) {
        socket.emit('invalid-move', { reason: 'You are not a player in that game.' });
        return;
      }
      if (room.status !== 'playing') {
        socket.emit('invalid-move', { reason: 'The game is not in progress.' });
        return;
      }
      if (room.chess.turn() !== playerColour) {
        socket.emit('invalid-move', { reason: 'It is not your turn.' });
        return;
      }

      const fromSquare = typeof payload.from === 'string' ? payload.from : null;
      const toSquare = typeof payload.to === 'string' ? payload.to : null;
      if (!fromSquare || !toSquare) {
        socket.emit('invalid-move', { reason: 'Malformed move.' });
        return;
      }

      // Ask chess.js which moves are actually available from that square. This
      // also tells us whether the move is a promotion, which the client is
      // never trusted to declare — promotion is always to a queen here.
      const candidateMoves = room.chess.moves({ square: fromSquare, verbose: true });
      const matchingMove = candidateMoves.find((move) => move.to === toSquare);
      if (!matchingMove) {
        socket.emit('invalid-move', { reason: 'That move is not legal.' });
        return;
      }

      const moveRequest = { from: fromSquare, to: toSquare };
      if (matchingMove.promotion) {
        moveRequest.promotion = 'q';
      }

      let appliedMove;
      try {
        appliedMove = room.chess.move(moveRequest);
      } catch (moveError) {
        console.error(`[relay] room ${room.code}: chess.js rejected a validated move`, moveError);
        socket.emit('invalid-move', { reason: 'The server could not apply that move.' });
        return;
      }

      room.lastActivityAt = Date.now();
      const position = describePosition(room);

      // Broadcast to BOTH players, including the one who moved: a single code
      // path updating both boards is much harder to get subtly wrong than one
      // client applying its move optimistically and the other applying it from
      // the network.
      io.to(room.code).emit('move-made', {
        from: appliedMove.from,
        to: appliedMove.to,
        piece: appliedMove.piece,
        colour: appliedMove.color,
        captured: appliedMove.captured || null,
        promotion: appliedMove.promotion || null,
        san: appliedMove.san,
        ...position,
      });

      if (position.isGameOver) {
        let outcome = 'draw';
        if (position.isCheckmate) {
          // chess.js has already switched sides, so the winner is the player
          // who is NOT to move.
          outcome = position.turn === 'w' ? 'black-wins' : 'white-wins';
        } else if (position.isStalemate) {
          outcome = 'stalemate';
        }
        console.log(`[relay] room ${room.code} finished: ${outcome}`);
        concludeGame(room, outcome);
      }
    });

    /* ---- leave-room --------------------------------------------------- */
    socket.on('leave-room', () => {
      const room = findRoomForSocket(socket.id);
      if (!room) {
        return;
      }
      socket.to(room.code).emit('opponent-left', { reason: 'Your opponent left the game.' });
      socket.leave(room.code);
      concludeGame(room, 'abandoned');
      removeRoom(room, 'a player left');
    });

    /* ---- disconnect ---------------------------------------------------- *
     * A closed tab, a locked phone or a lost connection all arrive here. With
     * only two players and no reconnection window, the honest thing to do is
     * end the game and tell the other player why, rather than leaving them
     * waiting for a move that will never come. */
    socket.on('disconnect', (disconnectReason) => {
      console.log(`[relay] socket disconnected: ${socket.id} (${disconnectReason})`);
      const room = findRoomForSocket(socket.id);
      if (!room) {
        return;
      }
      socket.to(room.code).emit('opponent-left', { reason: 'Your opponent disconnected.' });
      concludeGame(room, 'abandoned');
      removeRoom(room, 'a player disconnected');
    });
  });

  /* --------------------------------------------------------------------- *
   * Housekeeping
   * --------------------------------------------------------------------- */

  // A room created but never joined would otherwise sit in memory forever.
  // On a small free-tier instance that is a genuine (if slow) leak.
  const idleSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const room of Array.from(roomsByCode.values())) {
      if (now - room.lastActivityAt > IDLE_ROOM_TIMEOUT_MS) {
        io.to(room.code).emit('opponent-left', { reason: 'The game was closed after being idle.' });
        removeRoom(room, 'idle');
      }
    }
  }, IDLE_SWEEP_INTERVAL_MS);
  // Do not hold the Node process open just for the sweep timer.
  if (typeof idleSweepTimer.unref === 'function') {
    idleSweepTimer.unref();
  }

  return {
    rooms: roomsByCode,
    shutdown() {
      clearInterval(idleSweepTimer);
      roomsByCode.clear();
    },
  };
}

module.exports = { attachChessRelay };
