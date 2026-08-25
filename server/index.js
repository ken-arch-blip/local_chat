const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');
const db = require('./db');
const { transaction } = db;

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
// Avatar tiles render near-black text, so every colour here is a light tint.
const COLORS = ['#e4e4e2', '#cdd8dd', '#d3ddd0', '#e0d4d8', '#d5d3e0',
                '#e2dcd0', '#cfdcd8', '#ddd6cd', '#d8dce0', '#dcd8d2'];

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

/* ---------------------------------------------------------- helpers ----- */

const now = () => Date.now();
const pickColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];

function signToken(userId) {
  return jwt.sign({ uid: userId }, SECRET, { expiresIn: '30d' });
}

function setAuthCookie(res, token) {
  res.cookie('huddle_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function userFromToken(token) {
  if (!token) return null;
  try {
    const { uid } = jwt.verify(token, SECRET);
    return db.prepare('SELECT id, username, display_name, color, status_text FROM users WHERE id = ?').get(uid) || null;
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  const user = userFromToken(req.cookies.huddle_token);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  req.user = user;
  next();
}

/** Throws if the user may not read/write this channel. */
function assertChannelAccess(channelId, userId) {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch) throw Object.assign(new Error('Channel not found.'), { status: 404 });
  if (ch.type === 'dm') {
    const p = db.prepare('SELECT 1 FROM dm_participants WHERE channel_id = ? AND user_id = ?').get(channelId, userId);
    if (!p) throw Object.assign(new Error('No access to this conversation.'), { status: 403 });
  } else {
    const m = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(ch.server_id, userId);
    if (!m) throw Object.assign(new Error('No access to this channel.'), { status: 403 });
  }
  return ch;
}

function channelAudience(channelId) {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch) return [];
  if (ch.type === 'dm') {
    return db.prepare('SELECT user_id FROM dm_participants WHERE channel_id = ?').all(channelId).map(r => r.user_id);
  }
  return db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(ch.server_id).map(r => r.user_id);
}

function hydrateMessage(row) {
  if (!row) return null;
  const reactions = db.prepare(
    'SELECT emoji, COUNT(*) AS count, GROUP_CONCAT(user_id) AS users FROM reactions WHERE message_id = ? GROUP BY emoji'
  ).all(row.id).map(r => ({ emoji: r.emoji, count: r.count, users: String(r.users).split(',').map(Number) }));

  let replyTo = null;
  if (row.reply_to) {
    const r = db.prepare(`
      SELECT m.id, m.content, m.deleted, u.display_name
      FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?`).get(row.reply_to);
    if (r) replyTo = { id: r.id, author: r.display_name || 'Unknown', content: r.deleted ? null : r.content };
  }

  return {
    id: row.id,
    channel_id: row.channel_id,
    user_id: row.user_id,
    author: row.display_name || 'Deleted user',
    username: row.username || null,
    color: row.color || '#747f8d',
    content: row.deleted ? null : row.content,
    kind: row.kind,
    deleted: !!row.deleted,
    created_at: row.created_at,
    edited_at: row.edited_at,
    reply_to: replyTo,
    reactions,
  };
}

const MSG_SELECT = `
  SELECT m.*, u.display_name, u.username, u.color
  FROM messages m LEFT JOIN users u ON u.id = m.user_id`;

function getMessage(id) {
  return hydrateMessage(db.prepare(`${MSG_SELECT} WHERE m.id = ?`).get(id));
}

/* -------------------------------------------------------------- auth ----- */

app.post('/api/register', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const displayName = String(req.body.display_name || username).trim();

  if (!/^[a-z0-9_.]{3,20}$/i.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, _ or .' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (displayName.length < 1 || displayName.length > 32) {
    return res.status(400).json({ error: 'Display name must be 1-32 characters.' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'That username is taken.' });
  }

  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, color, created_at) VALUES (?,?,?,?,?)'
  ).run(username, displayName, hash, pickColor(), now());

  setAuthCookie(res, signToken(info.lastInsertRowid));
  res.json({ user: db.prepare('SELECT id, username, display_name, color, status_text FROM users WHERE id = ?').get(info.lastInsertRowid) });
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  setAuthCookie(res, signToken(row.id));
  res.json({ user: { id: row.id, username: row.username, display_name: row.display_name, color: row.color, status_text: row.status_text } });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('huddle_token');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

app.patch('/api/me', auth, (req, res) => {
  const displayName = req.body.display_name !== undefined ? String(req.body.display_name).trim() : req.user.display_name;
  const color = req.body.color !== undefined ? String(req.body.color) : req.user.color;
  const statusText = req.body.status_text !== undefined ? String(req.body.status_text).slice(0, 60) : req.user.status_text;

  if (displayName.length < 1 || displayName.length > 32) return res.status(400).json({ error: 'Display name must be 1-32 characters.' });
  if (!/^#[0-9a-f]{6}$/i.test(color)) return res.status(400).json({ error: 'Invalid color.' });

  db.prepare('UPDATE users SET display_name = ?, color = ?, status_text = ? WHERE id = ?')
    .run(displayName, color, statusText, req.user.id);

  const user = db.prepare('SELECT id, username, display_name, color, status_text FROM users WHERE id = ?').get(req.user.id);
  broadcastToAll({ t: 'user_update', user });
  res.json({ user });
});

/* ----------------------------------------------------------- servers ----- */

function serverPayload(serverId, userId) {
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!s) return null;
  const channels = db.prepare('SELECT id, name, type, position FROM channels WHERE server_id = ? ORDER BY type DESC, position, id').all(serverId);
  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.color, u.status_text
    FROM server_members sm JOIN users u ON u.id = sm.user_id
    WHERE sm.server_id = ? ORDER BY u.display_name COLLATE NOCASE`).all(serverId);
  return {
    id: s.id, name: s.name, owner_id: s.owner_id,
    invite_code: s.owner_id === userId ? s.invite_code : undefined,
    channels, members,
  };
}

app.get('/api/servers', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT s.id FROM servers s JOIN server_members sm ON sm.server_id = s.id
    WHERE sm.user_id = ? ORDER BY sm.joined_at`).all(req.user.id);
  res.json({ servers: rows.map(r => serverPayload(r.id, req.user.id)) });
});

app.post('/api/servers', auth, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name.length < 1 || name.length > 40) return res.status(400).json({ error: 'Server name must be 1-40 characters.' });

  const code = crypto.randomBytes(4).toString('hex');
  const t = now();
  const created = transaction(() => {
    const s = db.prepare('INSERT INTO servers (name, owner_id, invite_code, created_at) VALUES (?,?,?,?)')
      .run(name, req.user.id, code, t);
    const sid = s.lastInsertRowid;
    db.prepare('INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?,?,?)').run(sid, req.user.id, t);
    db.prepare('INSERT INTO channels (server_id, name, type, position, created_at) VALUES (?,?,?,?,?)').run(sid, 'general', 'text', 0, t);
    db.prepare('INSERT INTO channels (server_id, name, type, position, created_at) VALUES (?,?,?,?,?)').run(sid, 'random', 'text', 1, t);
    db.prepare('INSERT INTO channels (server_id, name, type, position, created_at) VALUES (?,?,?,?,?)').run(sid, 'General', 'voice', 0, t);
    return sid;
  })();

  res.json({ server: serverPayload(created, req.user.id) });
});

app.post('/api/servers/join', auth, (req, res) => {
  const code = String(req.body.code || '').trim().toLowerCase();
  const s = db.prepare('SELECT * FROM servers WHERE invite_code = ?').get(code);
  if (!s) return res.status(404).json({ error: 'No server with that invite code.' });

  const already = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(s.id, req.user.id);
  if (!already) {
    db.prepare('INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?,?,?)').run(s.id, req.user.id, now());
    const general = db.prepare("SELECT id FROM channels WHERE server_id = ? AND type = 'text' ORDER BY position, id LIMIT 1").get(s.id);
    if (general) {
      const info = db.prepare('INSERT INTO messages (channel_id, user_id, content, kind, created_at) VALUES (?,?,?,?,?)')
        .run(general.id, req.user.id, `${req.user.display_name} joined the server.`, 'system', now());
      broadcast(channelAudience(general.id), { t: 'message', message: getMessage(info.lastInsertRowid) });
    }
    const members = db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(s.id).map(r => r.user_id);
    broadcast(members, { t: 'server_update', server_id: s.id });

    // The joiner's socket connected before this membership existed, so the
    // existing members never saw a presence event for them — and vice versa.
    if (sockets.has(req.user.id)) {
      broadcast(members.filter(id => id !== req.user.id), { t: 'presence', user_id: req.user.id, online: true });
    }
    sendPresenceSnapshot(req.user.id);
  }
  res.json({ server: serverPayload(s.id, req.user.id), already: !!already });
});

app.post('/api/servers/:id/channels', auth, (req, res) => {
  const sid = Number(req.params.id);
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(sid);
  if (!s) return res.status(404).json({ error: 'Server not found.' });
  if (s.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the server owner can add channels.' });

  const name = String(req.body.name || '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 24);
  const type = req.body.type === 'voice' ? 'voice' : 'text';
  if (!name) return res.status(400).json({ error: 'Channel needs a name.' });

  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE server_id = ? AND type = ?').get(sid, type).p;
  const info = db.prepare('INSERT INTO channels (server_id, name, type, position, created_at) VALUES (?,?,?,?,?)')
    .run(sid, name, type, pos, now());

  broadcast(db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(sid).map(r => r.user_id),
    { t: 'server_update', server_id: sid });
  res.json({ channel: db.prepare('SELECT id, name, type, position FROM channels WHERE id = ?').get(info.lastInsertRowid) });
});

app.delete('/api/channels/:id', auth, (req, res) => {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(req.params.id));
  if (!ch || ch.type === 'dm') return res.status(404).json({ error: 'Channel not found.' });
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(ch.server_id);
  if (s.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the server owner can delete channels.' });

  const remaining = db.prepare("SELECT COUNT(*) AS c FROM channels WHERE server_id = ? AND type = 'text'").get(ch.server_id).c;
  if (ch.type === 'text' && remaining <= 1) return res.status(400).json({ error: 'A server needs at least one text channel.' });

  const audience = channelAudience(ch.id);
  db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
  broadcast(audience, { t: 'server_update', server_id: ch.server_id });
  res.json({ ok: true });
});

/* --------------------------------------------------------------- DMs ----- */

app.get('/api/dms', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.name,
           (SELECT MAX(m.id) FROM messages m WHERE m.channel_id = c.id) AS last_id
    FROM channels c JOIN dm_participants p ON p.channel_id = c.id
    WHERE c.type = 'dm' AND p.user_id = ?`).all(req.user.id);

  const dms = rows.map(r => {
    const other = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.color FROM dm_participants p
      JOIN users u ON u.id = p.user_id WHERE p.channel_id = ? AND p.user_id != ?`).get(r.id, req.user.id);
    return { id: r.id, other, last_id: r.last_id || 0 };
  }).filter(d => d.other);

  dms.sort((a, b) => b.last_id - a.last_id);
  res.json({ dms });
});

app.post('/api/dms', auth, (req, res) => {
  const username = String(req.body.username || '').trim();
  const other = db.prepare('SELECT id, username, display_name, color FROM users WHERE username = ?').get(username);
  if (!other) return res.status(404).json({ error: 'No user with that username.' });
  if (other.id === req.user.id) return res.status(400).json({ error: "You can't DM yourself." });

  const existing = db.prepare(`
    SELECT c.id FROM channels c
    JOIN dm_participants a ON a.channel_id = c.id AND a.user_id = ?
    JOIN dm_participants b ON b.channel_id = c.id AND b.user_id = ?
    WHERE c.type = 'dm'`).get(req.user.id, other.id);

  if (existing) return res.json({ dm: { id: existing.id, other } });

  const id = transaction(() => {
    const info = db.prepare("INSERT INTO channels (server_id, name, type, position, created_at) VALUES (NULL, ?, 'dm', 0, ?)")
      .run(`dm-${req.user.id}-${other.id}`, now()).lastInsertRowid;
    db.prepare('INSERT INTO dm_participants (channel_id, user_id) VALUES (?,?)').run(info, req.user.id);
    db.prepare('INSERT INTO dm_participants (channel_id, user_id) VALUES (?,?)').run(info, other.id);
    return info;
  })();

  broadcast([other.id], { t: 'dm_created', channel_id: id });
  sendPresenceSnapshot(req.user.id);
  sendPresenceSnapshot(other.id);
  res.json({ dm: { id, other } });
});

app.get('/api/users/search', auth, (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  const users = db.prepare(`
    SELECT id, username, display_name, color FROM users
    WHERE (username LIKE ? OR display_name LIKE ?) AND id != ? LIMIT 8`).all(q, q, req.user.id);
  res.json({ users });
});

/* ---------------------------------------------------------- messages ----- */

app.get('/api/channels/:id/messages', auth, (req, res, next) => {
  try {
    const cid = Number(req.params.id);
    assertChannelAccess(cid, req.user.id);
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const rows = db.prepare(`${MSG_SELECT} WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT 50`).all(cid, before);
    res.json({ messages: rows.reverse().map(hydrateMessage) });
  } catch (e) { next(e); }
});

app.post('/api/channels/:id/messages', auth, (req, res, next) => {
  try {
    const cid = Number(req.params.id);
    assertChannelAccess(cid, req.user.id);
    const content = String(req.body.content || '').trim();
    if (!content) return res.status(400).json({ error: 'Message is empty.' });
    if (content.length > 2000) return res.status(400).json({ error: 'Message is too long (2000 characters max).' });

    let replyTo = Number(req.body.reply_to) || null;
    if (replyTo) {
      const parent = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(replyTo);
      if (!parent || parent.channel_id !== cid) replyTo = null;
    }

    const info = db.prepare('INSERT INTO messages (channel_id, user_id, content, kind, reply_to, created_at) VALUES (?,?,?,?,?,?)')
      .run(cid, req.user.id, content, 'user', replyTo, now());

    const message = getMessage(info.lastInsertRowid);
    broadcast(channelAudience(cid), { t: 'message', message });
    res.json({ message });
  } catch (e) { next(e); }
});

app.patch('/api/messages/:id', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(req.params.id));
  if (!m || m.deleted) return res.status(404).json({ error: 'Message not found.' });
  if (m.user_id !== req.user.id) return res.status(403).json({ error: 'You can only edit your own messages.' });

  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Message is empty.' });
  if (content.length > 2000) return res.status(400).json({ error: 'Message is too long (2000 characters max).' });

  db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(content, now(), m.id);
  const message = getMessage(m.id);
  broadcast(channelAudience(m.channel_id), { t: 'message_update', message });
  res.json({ message });
});

app.delete('/api/messages/:id', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Message not found.' });

  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(m.channel_id);
  const owner = ch && ch.server_id
    ? db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(ch.server_id)?.owner_id
    : null;
  if (m.user_id !== req.user.id && owner !== req.user.id) {
    return res.status(403).json({ error: 'You can only delete your own messages.' });
  }

  db.prepare("UPDATE messages SET deleted = 1, content = '' WHERE id = ?").run(m.id);
  const message = getMessage(m.id);
  broadcast(channelAudience(m.channel_id), { t: 'message_update', message });
  res.json({ ok: true });
});

app.put('/api/messages/:id/reactions', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(req.params.id));
  if (!m || m.deleted) return res.status(404).json({ error: 'Message not found.' });
  try { assertChannelAccess(m.channel_id, req.user.id); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message }); }

  const emoji = String(req.body.emoji || '').slice(0, 8);
  if (!emoji) return res.status(400).json({ error: 'No emoji given.' });

  const existing = db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(m.id, req.user.id, emoji);
  if (existing) {
    db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(m.id, req.user.id, emoji);
  } else {
    db.prepare('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?,?,?)').run(m.id, req.user.id, emoji);
  }

  const message = getMessage(m.id);
  broadcast(channelAudience(m.channel_id), { t: 'message_update', message });
  res.json({ message });
});

/* ------------------------------------------------------------- static --- */

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Something went wrong on the server.' : err.message });
});

/* --------------------------------------------------------- websockets --- */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** userId -> Set<ws> */
const sockets = new Map();
/** channelId -> Map<userId, {muted, deafened}> */
const voiceRooms = new Map();
/** channelId -> Map<userId, timestamp> */
const typing = new Map();

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(userIds, payload) {
  for (const uid of new Set(userIds)) {
    const set = sockets.get(uid);
    if (set) for (const ws of set) send(ws, payload);
  }
}

function broadcastToAll(payload) {
  for (const set of sockets.values()) for (const ws of set) send(ws, payload);
}

/** Everyone who shares a server or DM with this user, plus the user. */
function peersOf(userId) {
  const rows = db.prepare(`
    SELECT DISTINCT other.user_id AS id FROM server_members mine
    JOIN server_members other ON other.server_id = mine.server_id
    WHERE mine.user_id = ?
    UNION
    SELECT DISTINCT o.user_id FROM dm_participants me
    JOIN dm_participants o ON o.channel_id = me.channel_id
    WHERE me.user_id = ?`).all(userId, userId);
  return rows.map(r => r.id);
}

/** Tell one user which of *their* peers are currently online. */
function sendPresenceSnapshot(userId) {
  const set = sockets.get(userId);
  if (!set) return;
  const online = peersOf(userId).filter(id => sockets.has(id));
  for (const ws of set) send(ws, { t: 'presence_snapshot', online });
}

function voiceStatePayload(channelId) {
  const room = voiceRooms.get(channelId) || new Map();
  const users = [...room.entries()].map(([uid, st]) => {
    const u = db.prepare('SELECT id, username, display_name, color FROM users WHERE id = ?').get(uid);
    return u ? { ...u, ...st } : null;
  }).filter(Boolean);
  return { t: 'voice_state', channel_id: channelId, users };
}

function leaveVoice(ws) {
  if (ws.voiceChannel == null) return;
  const cid = ws.voiceChannel;
  const room = voiceRooms.get(cid);
  ws.voiceChannel = null;
  if (!room) return;
  room.delete(ws.userId);
  if (room.size === 0) voiceRooms.delete(cid);
  broadcast(channelAudience(cid), voiceStatePayload(cid));
  broadcast([...room.keys()], { t: 'rtc_peer_left', channel_id: cid, user_id: ws.userId });
}

wss.on('connection', (ws, req) => {
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map(c => {
      const i = c.indexOf('=');
      return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
    })
  );
  const user = userFromToken(cookies.huddle_token);
  if (!user) { send(ws, { t: 'error', error: 'Not signed in.' }); ws.close(); return; }

  ws.userId = user.id;
  ws.isAlive = true;
  ws.voiceChannel = null;

  if (!sockets.has(user.id)) sockets.set(user.id, new Set());
  const first = sockets.get(user.id).size === 0;
  sockets.get(user.id).add(ws);

  // Only ever reveal the presence of people who share a server or DM with them.
  send(ws, { t: 'ready', user, online: peersOf(user.id).filter(id => sockets.has(id)) });
  if (first) broadcast(peersOf(user.id), { t: 'presence', user_id: user.id, online: true });

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.t) {
      case 'typing': {
        const cid = Number(msg.channel_id);
        try { assertChannelAccess(cid, user.id); } catch { return; }
        if (!typing.has(cid)) typing.set(cid, new Map());
        typing.get(cid).set(user.id, Date.now());
        broadcast(channelAudience(cid).filter(id => id !== user.id),
          { t: 'typing', channel_id: cid, user_id: user.id, display_name: user.display_name });
        break;
      }

      case 'voice_join': {
        const cid = Number(msg.channel_id);
        let ch;
        try { ch = assertChannelAccess(cid, user.id); } catch { return; }
        if (ch.type !== 'voice') return;

        leaveVoice(ws);
        ws.voiceChannel = cid;
        if (!voiceRooms.has(cid)) voiceRooms.set(cid, new Map());
        const room = voiceRooms.get(cid);
        const existingPeers = [...room.keys()].filter(id => id !== user.id);
        room.set(user.id, { muted: false, deafened: false });

        // Newcomer initiates offers to everyone already in the room.
        send(ws, { t: 'rtc_init', channel_id: cid, peers: existingPeers });
        broadcast(channelAudience(cid), voiceStatePayload(cid));
        break;
      }

      case 'voice_leave':
        leaveVoice(ws);
        break;

      case 'voice_update': {
        const cid = ws.voiceChannel;
        if (cid == null) return;
        const room = voiceRooms.get(cid);
        if (!room || !room.has(user.id)) return;
        room.set(user.id, { muted: !!msg.muted, deafened: !!msg.deafened });
        broadcast(channelAudience(cid), voiceStatePayload(cid));
        break;
      }

      case 'rtc_signal': {
        const target = Number(msg.to);
        const room = voiceRooms.get(ws.voiceChannel);
        if (!room || !room.has(target)) return;
        broadcast([target], {
          t: 'rtc_signal',
          channel_id: ws.voiceChannel,
          from: user.id,
          signal: msg.signal,
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    leaveVoice(ws);
    const set = sockets.get(user.id);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      sockets.delete(user.id);
      broadcast(peersOf(user.id), { t: 'presence', user_id: user.id, online: false });
    }
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => console.log(`Huddle listening on :${PORT}`));

module.exports = server;
