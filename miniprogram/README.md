# 城市飞奔 · 微信小程序

Open this folder (`miniprogram/`) in WeChat DevTools. It is not an npm workspace and is not part of the website build.

- `project.config.json`: replace `appid` (`touristappid` is the DevTools test id) with the mini program's AppID.
- `app.js`: `globalData.apiBase` is the backend (`https://cityrunproject.cn`); add it as a request domain in the mini program admin console (开发管理 → 开发设置 → 服务器域名).
- `project.private.config.json` holds per-developer DevTools settings and is not committed.
