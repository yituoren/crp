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
      const right = menu && menu.left ? win.windowWidth - menu.left + 4 : 96;
      this.setData({ top, height, right });
      this.triggerEvent('measure', { height: top + height });
    },
  },
});
