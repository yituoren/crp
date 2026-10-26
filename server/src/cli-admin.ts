// Create or reset an admin account (highest privilege).
// Usage: npm run create-admin --workspace=server -- <username> <password>
// On the server use deploy/create-admin.sh (it sets DATA_DIR=/opt/crp/data)
import bcrypt from 'bcryptjs';
import { get, run, now } from './db.js';
import { seed } from './seed.js';

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 4) {
  console.error('Usage: create-admin <username> <password (min 4 chars)>');
  process.exit(1);
}
seed();
const hash = await bcrypt.hash(password, 10);
run('INSERT OR IGNORE INTO access_list(username, added_by, added_at) VALUES (?,?,?)', username, 'system', now());
const existing = get('SELECT id FROM users WHERE username = ?', username);
if (existing) {
  run("UPDATE users SET role = 'admin', password_hash = ?, disabled = 0 WHERE id = ?", hash, existing.id);
  console.log(`[admin] user "${username}" promoted to admin, password reset`);
} else {
  run("INSERT INTO users(username, password_hash, display_name, role, created_at) VALUES (?,?,?,'admin',?)", username, hash, username, now());
  console.log(`[admin] admin account "${username}" created`);
}
