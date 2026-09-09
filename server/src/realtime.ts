import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';

export let io: Server | null = null;

export function attachRealtime(httpServer: HttpServer) {
  io = new Server(httpServer, { path: '/socket.io', cors: { origin: true, credentials: true } });
  io.on('connection', (socket) => {
    socket.emit('hello', { serverTime: new Date().toISOString() });
  });
  return io;
}
