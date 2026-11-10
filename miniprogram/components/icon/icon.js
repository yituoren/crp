// Material icon as an SVG image (WXML has no inline SVG): <icon-m name="menu" size="24" color="#444746" />
const PATHS = require('../../utils/icons');

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Base64 of an ASCII string (the SVG markup), as data URLs need it */
function base64(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (isNaN(b) ? '=' : B64[(n >> 6) & 63]) + (isNaN(c) ? '=' : B64[n & 63]);
  }
  return out;
}
const cache = {};
function iconUrl(name, color) {
  const key = name + color;
  if (!cache[key]) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${color}" d="${PATHS[name] || ''}"/></svg>`;
    cache[key] = 'data:image/svg+xml;base64,' + base64(svg);
  }
  return cache[key];
}

Component({
  properties: {
    name: { type: String, value: '' },
    size: { type: Number, value: 20 },
    color: { type: String, value: '#444746' },
  },
  data: { src: '' },
  observers: {
    'name, color': function (name, color) { this.setData({ src: iconUrl(name, color) }); },
  },
});
