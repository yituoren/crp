// 创建或重置管理员账号（最高权限）。
// 用法：npm run create-admin --workspace=server -- <用户名> <密码>
// 服务器上请用 deploy/create-admin.sh（它会指定 DATA_DIR=/opt/crp/data）
import bcrypt from 'bcryptjs';
import { get, run, now } from './db.js';
import { seed } from './seed.js';

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 4) {
  console.error('用法: create-admin <用户名> <密码(至少4位)>');
  process.exit(1);
}
seed();
const hash = await bcrypt.hash(password, 10);
run('INSERT OR IGNORE INTO access_list(username, added_by, added_at) VALUES (?,?,?)', username, 'system', now());
const existing = get('SELECT id FROM users WHERE username = ?', username);
if (existing) {
  run("UPDATE users SET role = 'admin', password_hash = ?, disabled = 0 WHERE id = ?", hash, existing.id);
  console.log(`已将 ${username} 设为管理员并重置密码`);
} else {
  run("INSERT INTO users(username, password_hash, display_name, role, created_at) VALUES (?,?,?,'admin',?)", username, hash, username, now());
  console.log(`已创建管理员账号 ${username}`);
}
