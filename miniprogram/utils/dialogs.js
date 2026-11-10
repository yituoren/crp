// Dialogs hosted by the event page (one instance each), reachable from any component
function host(id) {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  return page && page.selectComponent(id);
}
/** The record-time dialog: resolves with an ISO time, or null when cancelled */
function askTime(title, message) {
  const c = host('#timeSheet');
  return c ? c.ask(title, message) : Promise.resolve(null);
}
/** The edit-record dialog */
function editRecord(leg, team, progress) {
  const c = host('#editSheet');
  if (c) c.open({ leg, team, progress });
}
/** A confirm dialog; resolves true when confirmed */
function confirm(title, content, opts = {}) {
  return new Promise((resolve) => wx.showModal({
    title, content, confirmText: opts.okText || '确定', confirmColor: opts.danger ? '#b3261e' : '#0b57d0',
    success: (r) => resolve(!!r.confirm), fail: () => resolve(false),
  }));
}
const toast = (title) => wx.showToast({ title, icon: 'none' });

module.exports = { askTime, editRecord, confirm, toast };
