import { io, type Socket } from 'socket.io-client';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';

let socket: Socket | null = null;

export function connectRealtime() {
  if (socket) return socket;
  const race = useRace();
  const ui = useUi();
  socket = io({ path: '/socket.io', withCredentials: true, reconnectionDelayMax: 5000 });
  socket.on('connect', () => { ui.online = true; if (race.loaded) race.loadAll().catch(() => {}); });
  socket.on('disconnect', () => { ui.online = false; });
  socket.on('invalidate', (msg: { scope: string; episodeId: number | null }) => {
    race.invalidate(msg.scope, msg.episodeId).catch(() => {});
  });
  return socket;
}

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
}
