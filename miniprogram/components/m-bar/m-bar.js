// Top app bar (the mobile website's .m-bar) in place of WeChat's navigation bar: below the status bar,
// as tall as the capsule menu's row, leaving the capsule's space free on the right
Component({
  options: { multipleSlots: true },
  data: { top: 20, height: 44, right: 96 },
  lifetimes: {
    attached() {
      const win = wx.getWindowInfo();
      const menu = wx.getMenuButtonBoundingClientRect();
      const top = win.statusBarHeight || 20;
      const height = menu && menu.height ? (menu.top - top) * 2 + menu.height : 44;
      const right = menu && menu.left ? win.windowWidth - menu.left + 8 : 100;
      this.setData({ top, height, right });
      // top: status bar; row: the bar's own row (title, buttons); height: everything the bar covers
      // left: where the capsule menu starts (overlays should stay left of it)
      this.triggerEvent('measure', { top, row: height, height: top + height, left: menu && menu.left ? menu.left : win.windowWidth - 96 });
    },
  },
});
