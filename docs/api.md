# API reference

All endpoints live under `/api`. Requests and responses are JSON unless noted. Errors come back as `{ "error": "<message in Chinese>" }` with an HTTP status of 400 (validation), 401 (not signed in), 403 (forbidden / locked), 404 or 500.

## Authentication and scope

- Session: a `httpOnly` JWT cookie set by `POST /api/auth/login` or `/register`. Every other endpoint needs it.
- Global roles: `admin` (created from the command line only) and ordinary users. Per-event roles come from `event_members.role`: `host` or `crew`. Admins are hosts everywhere. The event creator is a fixed host.
- Event-scoped endpoints are mounted under `/api/events/:hash/…`. The caller must be a member (or admin), otherwise 403.
- Assignment roles inside an episode (`follow`, `station`, `live`) further narrow what crews may do; checks are server-side.
- Lock rule: once an episode is finished, or a team is eliminated / withdrawn, its records can only be changed by an admin. Before an episode starts, only admins can record.
- Money is sent and returned as numbers in the event's unit (yuan with 2 decimals, or whole coins); stored as integer cents.
- Live updates: the server emits Socket.IO `invalidate` events `{ scope, episodeId }` with scope in `episodes | teams | assignments | progress | ledger | announcements | admin | pitstop`. When an event is deleted it emits `event-deleted` `{ hash }`; clients inside that event return to the home page.

## Auth (`/api/auth`)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/login` | `{ username, password }` | sets cookie, returns `{ user }` |
| POST | `/register` | `{ username, password, displayName? }` | open registration |
| POST | `/logout` | – | clears cookie |
| GET | `/me` | – | `{ user: { id, username, displayName, role, createdAt }, hostAnywhere, serverTime }` |
| POST | `/change-password` | `{ oldPassword, newPassword }` | |
| PUT | `/profile` | `{ username }` | rename self; admin account cannot be renamed |

## Events list (before entering an event)

| Method | Path | Role | Body / notes |
|---|---|---|---|
| GET | `/events` | any | `{ mine, all }`; each `{ id, hash, name, joined, pending, role, ownerName, memberCount, episodeCount, status, createdAt }` |
| POST | `/events` | any | `{ name, inviteCode? }` → creates event, caller becomes host, returns `{ event }` |
| POST | `/events/join` | any | `{ code, hash?, note? }` → creates a pending join request (code must match) |
| POST | `/events/import` | signed in | multipart `file` (a `.crp` export, ≤ 200 MB) → new event with a new hash, the caller as owner and host; accounts are matched by username and `skippedUsers` lists the ones missing here (their schedule rows are dropped, other references cleared) |

## Users and system (admin only, except where noted)

| Method | Path | Notes |
|---|---|---|
| GET | `/users` | list accounts |
| PUT | `/users/:id` | `{ disabled?, username?, displayName? }`; admin account cannot be renamed |
| POST | `/users/:id/reset-password` | `{ password }` |
| DELETE | `/users/:id` | |
| GET | `/system/audit?limit=` | audit log across events |
| GET | `/system/export` | full JSON backup |
| POST | `/system/import` | body = backup JSON, replaces everything |
| POST | `/system/reset` | `{ includeAccounts }` |
| GET | `/files/:id` | any member: download an attachment |

## Event info and members (`/api/events/:hash`)

| Method | Path | Role | Body / notes |
|---|---|---|---|
| GET | `/info` | member | `{ event: { id, hash, name, teamSize, currencyMode, rbGap, inviteCode (hosts only), ownerId, myRole } }` |
| PUT | `/info` | host | `{ name?, inviteCode?, teamSize?, currencyMode? ('yuan'|'coin'), rbGap? }` |
| GET | `/members` | member | members with per-event role |
| PUT | `/members/:userId` | host | `{ role: 'host'|'crew' }` |
| GET | `/join-requests` | host | pending requests `{ id, user_id, username, note, created_at }` |
| POST | `/join-requests/:id/approve` | host | approves and adds as crew |
| POST | `/join-requests/:id/reject` | host | |
| GET | `/shop/items` | member | coin mode shop items |
| PUT | `/shop/items` | host | `{ items: [{ id?, name, price }] }` (missing ids are deleted) |
| GET | `/export` | host | downloads the event as a `.crp` file (gzip JSON, `format: 'crp-event-v1'`, attachments embedded; no accounts) |
| GET | `/audit?limit=` | admin | this event's audit log |
| DELETE | `/` (the event itself) | host | `{ name }` must equal the event name; deletes episodes, legs, attachments and their files, teams, records, ledger, item log, announcements, shop items, members and join requests (accounts and audit rows are kept), then emits `event-deleted` |

## Episodes and legs

| Method | Path | Role | Body / notes |
|---|---|---|---|
| GET | `/episodes` | member | episodes with legs, cutoffs, attachments; `judge_criteria` is `null` unless host or the leg's station |
| POST | `/episodes` | host | `{ code?, name?, budget?, notes? }`; first episode gets a Starting Line, every episode a Pit Stop |
| PUT | `/episodes/:id` | host | `{ name, budget, status, notes, sort, startAt (ISO or null), inheritRank, startGapMin }` |
| DELETE | `/episodes/:id` | host | |
| POST | `/episodes/:id/start` | host | manual start (testing); issues budget once, records departures from now |
| POST | `/episodes/:id/finish` | host | refuses while any racing team has not reached the pit stop |
| POST | `/episodes/:id/reset` | host | testing: clears records of this and later episodes |
| GET | `/episodes/:id/departures` | member | planned departure time per team |
| POST | `/episodes/:id/legs` | host¹ | leg fields (see below) |
| PUT | `/legs/:id` | host¹ | leg fields; structural fields (type, can_eliminate, eliminate_count, shop_open) locked after start |
| DELETE | `/legs/:id` | host¹ | |
| PUT | `/episodes/:id/legs/order` | host¹ | `{ ids: [legId…] }` |
| PUT | `/legs/:id/cutoffs` | host¹ | `{ items: [{ id?, name, start_min, interval_min, cost }] }` |
| POST | `/legs/:id/attachments` | host / station of the leg | multipart `file` (image or PDF, ≤ 10 MB) |
| DELETE | `/attachments/:id` | host / station of the leg | |

¹ After an episode has started (running or finished) these are admin only.

Leg fields: `type` (one of `SL RI TI DT RB FF Union Shuffle UT YD SB FO Trap SQ PS`), `name`, `description`, `address`, `map_url`, `clue_text`, `judge_criteria`, `open_time`, `close_time`, `detour_a`, `detour_b`, `shop_open`, `can_eliminate`, `eliminate_count`. A side quest (`SQ`) must directly follow a main leg.

## Teams

| Method | Path | Role | Body / notes |
|---|---|---|---|
| GET | `/teams` | member | `{ teams: [{ id, code, name, members, label, status, currency, rbCounts, inventory, eliminated_leg_id, locked_from_leg_id }] }` |
| POST | `/teams` | host | `{ members: [] }`; numbers are generated |
| PUT | `/teams/:id` | host | `{ members?, status? ('alive'|'withdrawn') }` |
| PUT | `/teams/order` | host | `{ ids }` → renumbers |
| DELETE | `/teams/:id` | host | removes all of the team's records |
| POST | `/teams/reset` | host | all alive, balances zero |

## Assignments

| Method | Path | Role | Body / notes |
|---|---|---|---|
| GET | `/episodes/:id/assignments` | member | |
| PUT | `/episodes/:id/assignments` | host | `{ items: [{ userId, role: 'follow'|'station'|'live', teamId?, legIds? }] }` (replaces the episode's schedule) |
| POST | `/episodes/:id/assignments/copy-from/:from` | host | copies follows from another episode |

## Progress

| Method | Path | Role | Body / notes |
|---|---|---|---|
| GET | `/episodes/:id/progress` | member | `{ progress, penalties, pitstop, cutoffUses }` |
| POST | `/progress` | host / follow of the team | `{ episodeId, teamId, legId, action, at?, value? }` — actions: `complete`, `arrive` (side quest start), `undo_complete`, `undo_arrive` (host), `detour`, `roadblock`, `ff`, `target`, `note` |
| PUT | `/progress/:episodeId/:teamId/:legId` | host / follow | `{ arrivedAt, completedAt, detourChoice, roadblockBy, ffResult, targetTeamId, note }` |
| POST | `/episodes/:id/penalties` | host / station / follow of the team | `{ teamId, legId (0 = other, hosts only), minutes (negative = time credit), reason }` |
| POST | `/penalties/:id/revert` | author or host | |
| GET | `/episodes/:id/pitstop` | member | rows with check-in, penalty minutes, final time, live rank |
| PUT | `/episodes/:id/pitstop/:teamId` | host | `{ checkinAt?, note? }` |
| POST | `/cutoffs/:id/use` | host / follow | `{ teamId }`; coin mode deducts the cost and writes a ledger row |
| DELETE | `/cutoff-uses/:id` | host | refunds the cost |
| GET | `/dashboard/:episodeId` | member | live board: current leg, last activity and balance per team |

## Money, shop and items

| Method | Path | Role | Body / notes |
|---|---|---|---|
| GET | `/ledger?episodeId=&teamId=` | member | currency ledger |
| POST | `/ledger` | host / follow of the team / station on its own legs | `{ episodeId, teamId, kind: 'other'|'shop'|'cutoff', delta?, reason?, legId?, itemId? }`; shop purchases need coin mode and a shop-open leg, and also write an item-log "+1" |
| POST | `/ledger/:id/revert` | author or host | reverting a purchase refunds and removes the item (refused if already used); reverting a cutoff row deletes that use |
| GET | `/item-log?episodeId=&teamId=` | member | item gains and uses (coin mode) |
| POST | `/items/use` | host / follow of the team | `{ episodeId, teamId, itemName, legId? }` — one item per call, no money change |
| POST | `/item-log/:id/revert` | author or host | only `use` rows; purchases are reverted through the ledger |

## Announcements

| Method | Path | Role | Body / notes |
|---|---|---|---|
| GET | `/announcements` | member | |
| POST | `/announcements` | host | `{ content, level?, audience? }` |
| POST | `/announcements/:id/pin` | host | `{ pinned }` |
| DELETE | `/announcements/:id` | host | |
| POST | `/announcements/read` | member | marks all as read for the caller |

## Health

`GET /api/health` → `{ ok: true, time }` (no auth).
