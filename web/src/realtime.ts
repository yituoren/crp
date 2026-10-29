import { io, type Socket } from 'socket.io-client';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { useAuth } from '@/stores/auth';
import { router } from '@/router';

let socket: Socket | null = null;
// Event this tab is deleting itself: skip the "deleted by a host" notice for it
let selfDeleting = '';
export function expectEventDeletion(hash: string) { selfDeleting = hash; }

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
  // The event someone is inside was deleted by a host: leave it
  socket.on('event-deleted', (msg: { hash: string }) => {
    const auth = useAuth();
    if (msg.hash === selfDeleting) return;
    if (!auth.event.hash || auth.event.hash !== msg.hash) return;
    ui.toast('本比赛已被主办删除');
    router.replace('/');
  });
  return socket;
}

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
}
