/**
 * server.js
 * =========
 * Entry point for AR Chess Arena's backend.
 *
 * The whole backend is deliberately small: an Express app (for a health check
 * and a status endpoint), an HTTP server, and a Socket.IO server attached to
 * it. All of the interesting behaviour lives in socket/chessRelay.js.
 *
 * WHY EXPRESS WRAPS AN http.Server RATHER THAN LISTENING ITSELF
 * -------------------------------------------------------------
 * Socket.IO does not attach to an Express application; it attaches to the
 * Node HTTP server underneath it. Creating that server explicitly lets both
 * share one port — which matters on hosts like Render, where exactly one port
 * is exposed per service.
 *
 * DEPLOYMENT (Render, free web service)
 *   root directory : backend
 *   build command  : npm install
 *   start command  : npm start
 *   environment    : ALLOWED_ORIGINS=https://<username>.github.io
 *
 * Render's standard web services proxy WebSocket connections without any
 * special configuration, so Socket.IO works as-is. Note that a free instance
 * sleeps after inactivity: the first connection after a nap can take 30–60
 * seconds to wake it, which the client shows as a "connecting" state rather
 * than an error.
 */

const http = require('node:http');
const express = require('express');
const cors = require('cors');
const { Server: SocketIoServer } = require('socket.io');

const { attachChessRelay } = require('./socket/chessRelay');

/* ------------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------------ */

const PORT = Number(process.env.PORT) || 3000;

/**
 * Which web origins may talk to this server.
 *
 * In production this must be set to the GitHub Pages origin. Left unset — as
 * it is during local development and phone testing through a tunnel — it falls
 * back to allowing any origin, because during testing the frontend's origin
 * changes every time a new tunnel is opened.
 */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin: allowedOrigins.length > 0 ? allowedOrigins : '*',
  methods: ['GET', 'POST'],
};

/* ------------------------------------------------------------------------ *
 * HTTP layer
 * ------------------------------------------------------------------------ */

const app = express();
app.use(cors(corsOptions));
app.use(express.json());

const serverStartedAt = Date.now();

/**
 * Health check. Render pings a service like this to decide whether a deploy
 * succeeded, and it doubles as a quick way to wake a sleeping free instance
 * before players try to connect.
 */
app.get('/', (request, response) => {
  response.json({
    service: 'ar-chess-arena-relay',
    status: 'ok',
    uptimeSeconds: Math.floor((Date.now() - serverStartedAt) / 1000),
  });
});

/**
 * A small amount of live state, useful when demonstrating the system and when
 * debugging a failed join. Deliberately exposes counts and codes only — never
 * socket ids, which would let anyone watch who is connected.
 */
app.get('/status', (request, response) => {
  response.json({
    activeRooms: relay.rooms.size,
    rooms: Array.from(relay.rooms.values()).map((room) => ({
      code: room.code,
      status: room.status,
      moves: room.chess.history().length,
      ageSeconds: Math.floor((Date.now() - room.createdAt) / 1000),
    })),
  });
});

const httpServer = http.createServer(app);

/* ------------------------------------------------------------------------ *
 * Realtime layer
 * ------------------------------------------------------------------------ */

const io = new SocketIoServer(httpServer, {
  cors: corsOptions,
  // Mobile connections drop and recover constantly. These are more forgiving
  // than the defaults, so a phone that briefly loses signal is not treated as
  // a player who has quit.
  pingInterval: 20000,
  pingTimeout: 25000,
});

const relay = attachChessRelay(io, {
  /**
   * EXTENSION POINT. The project plan describes an optional MongoDB layer that
   * would log completed games for a match history or leaderboard. It would be
   * implemented here — this callback already receives everything such a layer
   * would need — and nothing else in the codebase would have to change.
   */
  onGameFinished(gameSummary) {
    console.log(
      `[server] game ${gameSummary.code} finished: ${gameSummary.outcome} ` +
        `after ${gameSummary.moveHistory.length} half-moves`
    );
  },
});

/* ------------------------------------------------------------------------ *
 * Start-up and shutdown
 * ------------------------------------------------------------------------ */

httpServer.listen(PORT, () => {
  console.log(`[server] AR Chess Arena relay listening on port ${PORT}`);
  console.log(
    `[server] allowed origins: ${allowedOrigins.length > 0 ? allowedOrigins.join(', ') : '(any)'}`
  );
});

/**
 * Render restarts a service by sending SIGTERM. Closing cleanly means players
 * get an "opponent left" message instead of a connection that silently stops
 * responding.
 */
function shutDownGracefully(signalName) {
  console.log(`[server] received ${signalName}, shutting down`);
  relay.shutdown();
  io.close(() => {
    httpServer.close(() => process.exit(0));
  });
  // Never let a stuck socket keep the process alive indefinitely.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutDownGracefully('SIGTERM'));
process.on('SIGINT', () => shutDownGracefully('SIGINT'));

module.exports = { app, httpServer, io, relay };
