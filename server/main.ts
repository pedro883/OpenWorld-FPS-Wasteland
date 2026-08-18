/**
 * WebSocket front end for the authoritative server.
 *
 * All the game logic lives in `gameServer.ts`, which knows nothing about
 * sockets — this file is only the transport. That split is what lets the
 * acceptance test run two clients through a delay-injecting pipe with no
 * network at all, and it is why the same server can later sit behind anything
 * else that can carry strings.
 *
 * Run with `npm run server`. Node 24 strips the types on the way in, so there
 * is no build step for the server.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { GameServer, DEFAULT_OPTIONS, type Connection } from './gameServer.ts';

const PORT = Number(process.env.PORT ?? 8787);

const game = new GameServer(DEFAULT_OPTIONS);
game.start();

const wss = new WebSocketServer({ port: PORT });
wss.on('error', (err: NodeJS.ErrnoException) => {
  // A port clash is the common case and deserves an answer, not a stack trace.
  if (err.code === 'EADDRINUSE') {
    console.error(`A porta ${PORT} já está em uso. Feche o outro servidor ou rode com PORT=8788 npm run server.`);
  } else {
    console.error('erro no servidor:', err.message);
  }
  process.exit(1);
});
console.log(`Wasteland Web — servidor autoritativo em ws://localhost:${PORT}`);
console.log(`  seed ${DEFAULT_OPTIONS.seed} · até ${16} jogadores`);

wss.on('connection', (socket: WebSocket) => {
  const conn: Connection = {
    send: (data) => {
      if (socket.readyState === socket.OPEN) socket.send(data);
    },
    close: () => socket.close(),
  };

  const id = game.connect(conn);
  if (id === null) return;

  // Latency is measured by the client, which is the only side that can: it
  // owns both ends of the round trip. It reports the figure on each ping, and
  // the server clamps it before letting it drive the rewind.
  socket.on('message', (data: Buffer | string) => {
    game.receive(id, typeof data === 'string' ? data : data.toString('utf8'));
  });

  socket.on('close', () => {
    game.disconnect(id);
    console.log(`jogador ${id} saiu · ${game.playerCount} online`);
  });

  socket.on('error', () => socket.close());
  console.log(`jogador ${id} entrou · ${game.playerCount} online`);
});

const shutdown = (): void => {
  console.log('\nencerrando…');
  game.stop();
  wss.close(() => process.exit(0));
  // A socket that refuses to close must not hold the process open forever.
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
