/**
 * 导入原型（BJ20_CommandCenter.html）导出的 JSON 备份。
 * 结构：{ accounts, accessList, teams, episodes: { EP1: { legs, assignments, records, currencyLog } } }
 * 原型的到达/完成时间只有 HH:MM:SS，需要一个基准日期（默认今天，Asia/Shanghai）。
 */
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, tx, now, UPLOAD_DIR } from './db.js';
import { LEG_TYPES, TYPE_DEFAULTS } from './routes/episodes.js';

export interface ImportOptions {
  baseDate?: string;           // YYYY-MM-DD
  wipe?: boolean;              // 先清空比赛数据
}

function toIso(hms: string | null | undefined, baseDate: string): string | null {
  if (!hms) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(hms.trim());
  if (!m) return null;
  const d = new Date(`${baseDate}T${m[1].padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}+08:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function importPrototype(data: any, opts: ImportOptions = {}) {
  const baseDate = opts.baseDate ?? new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const report = { users: 0, accessList: 0, teams: 0, episodes: 0, legs: 0, attachments: 0, assignments: 0, progress: 0, ledger: 0, warnings: [] as string[] };

  // 密码哈希放在事务外（异步）
  const accounts: { username: string; hash: string; role: string; createdAt: string }[] = [];
  for (const [username, acc] of Object.entries<any>(data.accounts ?? {})) {
    const hash = await bcrypt.hash(String(acc.password ?? '1234'), 10);
    accounts.push({ username, hash, role: 'crew', createdAt: acc.createdAt ?? now() });
  }

  tx(() => {
    if (opts.wipe) {
      for (const t of ['pitstop_results', 'penalties', 'progress', 'currency_ledger', 'assignments', 'attachments']) run(`DELETE FROM ${t}`);
      run('DELETE FROM legs WHERE episode_id IN (SELECT id FROM episodes WHERE event_id = 1)'); run('DELETE FROM episodes WHERE event_id = 1'); run('DELETE FROM teams WHERE event_id = 1');
    }
    for (const a of accounts) {
      if (get('SELECT 1 FROM users WHERE username = ?', a.username)) { report.warnings.push(`账号 ${a.username} 已存在，跳过`); continue; }
      run('INSERT INTO users(username, password_hash, display_name, role, created_at) VALUES (?,?,?,?,?)', a.username, a.hash, a.username, a.role, a.createdAt);
      report.users++;
    }
    for (const username of Object.keys(data.accessList ?? {})) {
      const r = run('INSERT OR IGNORE INTO access_list(username, added_by, added_at) VALUES (?,?,?)', username, 'import', now());
      if (r.changes) report.accessList++;
    }
    const userIds = new Map(all('SELECT id, username FROM users').map((u) => [u.username, u.id]));

    const teamIds = new Map<string, number>();
    let sort = 0;
    for (const [code, t] of Object.entries<any>(data.teams ?? {})) {
      sort++;
      const existing = get('SELECT id FROM teams WHERE code = ? AND event_id = 1', code);
      if (existing) {
        run('UPDATE teams SET name = ?, status = ?, currency = ? WHERE id = ?', t.name ?? code, t.eliminated ? 'eliminated' : 'alive', Math.round(Number(t.currency ?? 0) * 100), existing.id);
        teamIds.set(code, existing.id);
      } else {
        const r = run('INSERT INTO teams(code, name, members, status, currency, sort, event_id) VALUES (?,?,?,?,?,?,1)', code, t.name ?? code, '', t.eliminated ? 'eliminated' : 'alive', Math.round(Number(t.currency ?? 0) * 100), sort);
        teamIds.set(code, Number(r.lastInsertRowid));
      }
      report.teams++;
    }

    let epSort = 0;
    for (const [code, ep] of Object.entries<any>(data.episodes ?? {})) {
      epSort++;
      let epId = get('SELECT id FROM episodes WHERE code = ? AND event_id = 1', code)?.id;
      if (!epId) {
        epId = Number(run('INSERT INTO episodes(code, name, budget, sort, status, notes, event_id) VALUES (?,?,?,?,?,?,1)', code, code, 0, epSort, 'pending', '').lastInsertRowid);
      } else {
        run('DELETE FROM legs WHERE episode_id = ?', epId);
      }
      report.episodes++;
      const legIds = new Map<string, number>();
      const legs = Object.values<any>(ep.legs ?? {}).sort((a, b) => String(a.id).localeCompare(String(b.id)));
      legs.forEach((leg, i) => {
        const type = LEG_TYPES.includes(leg.type) ? leg.type : 'TI';
        const d = TYPE_DEFAULTS[type] ?? { staff: 1, mode: 'full' };
        const r = run('INSERT INTO legs(episode_id, sort, type, name, description, needs_staff, record_mode) VALUES (?,?,?,?,?,?,?)', epId, i + 1, type, leg.name ?? leg.id, leg.desc ?? '', d.staff, d.mode);
        const legId = Number(r.lastInsertRowid);
        legIds.set(leg.id, legId);
        report.legs++;
        for (const att of leg.attachments ?? []) {
          const m = /^data:([^;]+);base64,(.+)$/.exec(String(att.data ?? ''));
          if (!m) continue;
          const ext = path.extname(att.name ?? '') || (m[1] === 'application/pdf' ? '.pdf' : '.bin');
          const stored = `${legId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
          const buf = Buffer.from(m[2], 'base64');
          fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
          run('INSERT INTO attachments(leg_id, filename, mime, path, size, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?)', legId, att.name ?? stored, m[1], stored, buf.length, null, att.uploadedAt ?? now());
          report.attachments++;
        }
      });
      for (const [username, a] of Object.entries<any>(ep.assignments ?? {})) {
        const uid = userIds.get(username);
        if (!uid) { report.warnings.push(`${code} 排班：账号 ${username} 不存在`); continue; }
        if (a.type === 'follow' && teamIds.get(a.teamId)) {
          run('INSERT OR REPLACE INTO assignments(episode_id, user_id, role, team_id, leg_id) VALUES (?,?,?,?,NULL)', epId, uid, 'follow', teamIds.get(a.teamId)!);
          report.assignments++;
        } else if (a.type === 'station' && legIds.get(a.legId)) {
          run('INSERT OR REPLACE INTO assignments(episode_id, user_id, role, team_id, leg_id) VALUES (?,?,?,NULL,?)', epId, uid, 'station', legIds.get(a.legId)!);
          report.assignments++;
        }
      }
      for (const [teamCode, recs] of Object.entries<any>(ep.records ?? {})) {
        const tid = teamIds.get(teamCode);
        if (!tid) continue;
        for (const [legKey, rec] of Object.entries<any>(recs ?? {})) {
          const lid = legIds.get(legKey);
          if (!lid) continue;
          const arrived = toIso(rec.arrivedAt, baseDate);
          const completed = rec.completed || rec.completedAt ? toIso(rec.completedAt, baseDate) ?? arrived : null;
          if (!arrived && !completed) continue;
          run(
            `INSERT OR REPLACE INTO progress(episode_id, team_id, leg_id, arrived_at, completed_at, note, recorded_by, updated_at) VALUES (?,?,?,?,?,?,NULL,?)`,
            epId, tid, lid, arrived ?? completed, completed, '', now(),
          );
          report.progress++;
        }
      }
      for (const [teamCode, logs] of Object.entries<any>(ep.currencyLog ?? {})) {
        const tid = teamIds.get(teamCode);
        if (!tid || !Array.isArray(logs)) continue;
        for (const log of logs) {
          run(
            'INSERT INTO currency_ledger(episode_id, team_id, delta, balance_after, reason, operator_id, operator_name, created_at) VALUES (?,?,?,?,?,?,?,?)',
            epId, tid, Math.round(Number(log.amount ?? 0) * 100), Math.round(Number(log.balance ?? 0) * 100), log.reason ?? '', userIds.get(log.staffId) ?? null, log.staffId ?? '', log.timestamp ?? now(),
          );
          report.ledger++;
        }
      }
    }
  });
  return report;
}
