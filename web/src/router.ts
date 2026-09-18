import { createRouter, createWebHistory } from 'vue-router';
import { useAuth } from '@/stores/auth';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('@/views/LoginView.vue'), meta: { public: true } },
    // 进比赛之前：个人主页、账号管理、改密
    {
      path: '/',
      component: () => import('@/components/PlainLayout.vue'),
      children: [
        { path: '', name: 'home', component: () => import('@/views/HomeView.vue') },
        { path: 'account', name: 'account', component: () => import('@/views/AccountView.vue'), meta: { account: true } },
        { path: 'password', name: 'password', component: () => import('@/views/ChangePasswordView.vue') },
      ],
    },
    // 比赛内：/e/<hash>/...
    {
      path: '/e/:hash',
      component: () => import('@/components/AppLayout.vue'),
      children: [
        { path: '', name: 'today', component: () => import('@/views/TodayView.vue') },
        { path: 'announcements', name: 'announcements', component: () => import('@/views/AnnouncementsView.vue'), meta: { fillPage: true } },
        { path: 'episodes', name: 'episodes', component: () => import('@/views/EpisodesView.vue') },
        { path: 'episodes/:episodeId/legs/:legId', name: 'leg', component: () => import('@/views/LegDetailView.vue') },
        { path: 'schedule', name: 'schedule', component: () => import('@/views/ScheduleView.vue') },
        { path: 'teams', name: 'teams', component: () => import('@/views/TeamsView.vue') },
        { path: 'currency', name: 'currency', component: () => import('@/views/CurrencyView.vue') },
        { path: 'progress', name: 'progress', component: () => import('@/views/ProgressView.vue') },
        { path: 'admin', name: 'admin', component: () => import('@/views/AdminView.vue') },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuth();
  if (!auth.ready) await auth.fetchMe();
  if (to.meta.public) return auth.user ? '/' : true;
  if (!auth.user) return { path: '/login', query: { redirect: to.fullPath } };
  if (to.meta.account && !(auth.isAdmin || auth.hostAnywhere)) return '/';
  return true;
});
