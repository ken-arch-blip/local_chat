/* Huddle client. Plain ES2018, no build step. */
(function () {
'use strict';

/* ================================================================ state == */

var state = {
  me: null,
  servers: [],
  dms: [],
  activeServer: null,      // server id, or null for the DM view
  activeChannel: null,     // channel id
  messages: [],            // messages for the active channel
  hasMore: false,
  online: new Set(),
  typing: new Map(),       // userId -> { name, expires }
  replyTo: null,
  editing: null,
  unread: new Map(),       // channelId -> count
  voice: {
    channelId: null,
    peers: new Map(),      // userId -> RTCPeerConnection
    stream: null,
    muted: false,
    deafened: false,
    members: new Map(),    // channelId -> [users]
    speaking: new Set()
  },
  ws: null,
  wsRetry: 0,
  justArrived: new Set()   // message ids to animate in on the next paint
};

var ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
var EMOJI = ['👍','❤️','😂','🎉','😮','😢','🔥','👀','✅','🙏','💯','😅','🤔','👋','🚀','😭'];

/* =============================================================== utils == */

var $ = function (id) { return document.getElementById(id); };

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function initials(name) {
  return String(name).trim().split(/\s+/).map(function (w) { return w[0]; })
    .slice(0, 2).join('').toUpperCase() || '?';
}

function toast(text, bad) {
  var el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = text;
  $('toast-root').appendChild(el);
  setTimeout(function () {
    el.classList.add('out');
    setTimeout(function () { el.remove(); }, 260);
  }, 3000);
}

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function dayLabel(ts) {
  var d = new Date(ts), today = new Date();
  var yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  var same = function (a, b) { return a.toDateString() === b.toDateString(); };
  if (same(d, today)) return 'Today';
  if (same(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function sameDay(a, b) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

async function api(method, path, body) {
  var res = await fetch('/api' + path, {
    method: method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  var data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || 'Request failed (' + res.status + ').');
  return data;
}

/** Linkify, inline-code and @mentions — after escaping. */
function renderText(text) {
  var out = esc(text);
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\bhttps?:\/\/[^\s<]+/g, function (url) {
    var trimmed = url.replace(/[.,!?;:)\]]+$/, '');
    var tail = url.slice(trimmed.length);
    return '<a href="' + trimmed + '" target="_blank" rel="noopener noreferrer">' + trimmed + '</a>' + tail;
  });
  if (state.me) {
    var re = new RegExp('@(' + state.me.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')\\b', 'gi');
    out = out.replace(re, '<span class="mention">@$1</span>');
  }
  return out;
}

/* ================================================================ auth == */

var authMode = location.hash === '#register' ? 'register' : 'login';

function paintAuth() {
  var isReg = authMode === 'register';
  $('auth-title').textContent = isReg ? 'Create your account' : 'Welcome back';
  $('auth-sub').textContent = isReg
    ? 'Pick a username your friends can DM you at.'
    : 'Sign in to get back to your people.';
  $('auth-submit').textContent = isReg ? 'Create account' : 'Sign in';
  $('auth-swap-text').textContent = isReg ? 'Already have an account?' : 'New here?';
  $('auth-swap').textContent = isReg ? 'Sign in instead' : 'Create an account';
  document.querySelector('.field-display').hidden = !isReg;
  $('f-display').required = isReg;
  $('f-password').autocomplete = isReg ? 'new-password' : 'current-password';
  $('auth-err').textContent = '';
}

$('auth-swap').addEventListener('click', function () {
  authMode = authMode === 'login' ? 'register' : 'login';
  history.replaceState(null, '', '#' + authMode);
  paintAuth();
});

$('auth-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  var btn = $('auth-submit');
  var err = $('auth-err');
  err.textContent = '';
  btn.disabled = true;

  try {
    var payload = {
      username: $('f-username').value.trim(),
      password: $('f-password').value
    };
    if (authMode === 'register') payload.display_name = $('f-display').value.trim() || payload.username;

    var data = await api('POST', authMode === 'register' ? '/register' : '/login', payload);
    state.me = data.user;
    await enterApp();
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});

/* ================================================================ boot == */

async function boot() {
  paintAuth();
  try {
    var data = await api('GET', '/me');
    state.me = data.user;
    await enterApp();
  } catch (e) {
    $('auth').hidden = false;
    $('f-username').focus();
  }
}

async function enterApp() {
  $('auth').hidden = true;
  $('app').hidden = false;
  paintMe();
  await Promise.all([loadServers(), loadDMs()]);
  connectWS();

  var last = null;
  try { last = JSON.parse(localStorage.getItem('huddle:last') || 'null'); } catch (e) {}
  if (last && last.server != null && state.servers.some(function (s) { return s.id === last.server; })) {
    selectServer(last.server, last.channel);
  } else if (state.servers.length) {
    selectServer(state.servers[0].id);
  } else {
    selectDMs();
  }
}

function paintMe() {
  var av = $('my-avatar');
  av.textContent = initials(state.me.display_name);
  av.style.background = state.me.color;
  $('my-name').textContent = state.me.display_name;
  $('my-status').textContent = state.me.status_text || 'Online';
}

async function loadServers() {
  state.servers = (await api('GET', '/servers')).servers.filter(Boolean);
  paintRail();
}

async function loadDMs() {
  state.dms = (await api('GET', '/dms')).dms;
}

/* ================================================================ rail == */

function paintRail() {
  var host = $('rail-servers');
  host.innerHTML = '';
  state.servers.forEach(function (s, i) {
    var unread = totalUnread(s);
    var el = document.createElement('button');
    el.className = 'rail-server' + (state.activeServer === s.id ? ' active' : '');
    el.style.animationDelay = (i * 40) + 'ms';
    el.title = s.name;
    el.innerHTML = esc(initials(s.name)) + (unread ? '<span class="badge">' + (unread > 99 ? '99+' : unread) + '</span>' : '');
    el.addEventListener('click', function () { selectServer(s.id); });
    host.appendChild(el);
  });

  var dmUnread = state.dms.reduce(function (n, d) { return n + (state.unread.get(d.id) || 0); }, 0);
  var home = $('rail-dms');
  home.classList.toggle('active', state.activeServer === null);
  var badge = home.querySelector('.badge');
  if (badge) badge.remove();
  if (dmUnread) {
    var b = document.createElement('span');
    b.className = 'badge';
    b.textContent = dmUnread > 99 ? '99+' : dmUnread;
    home.appendChild(b);
  }
}

function totalUnread(server) {
  var n = 0;
  server.channels.forEach(function (c) { n += state.unread.get(c.id) || 0; });
  return n;
}

$('rail-dms').addEventListener('click', function () { selectDMs(); });
$('rail-add').addEventListener('click', openServerModal);

/* ============================================================ sidebar == */

function currentServer() {
  return state.servers.find(function (s) { return s.id === state.activeServer; }) || null;
}

function findChannel(id) {
  for (var i = 0; i < state.servers.length; i++) {
    var c = state.servers[i].channels.find(function (ch) { return ch.id === id; });
    if (c) return c;
  }
  var dm = state.dms.find(function (d) { return d.id === id; });
  return dm ? { id: dm.id, name: dm.other.display_name, type: 'dm', other: dm.other } : null;
}

function selectServer(id, channelId) {
  var s = state.servers.find(function (x) { return x.id === id; });
  if (!s) return;
  state.activeServer = id;
  $('sidebar-title').textContent = s.name;
  $('server-menu-btn').hidden = false;
  paintRail();
  paintChannels();

  var target = s.channels.find(function (c) { return c.id === channelId && c.type === 'text'; })
    || s.channels.find(function (c) { return c.type === 'text'; });
  if (target) openChannel(target.id);
}

function selectDMs() {
  state.activeServer = null;
  $('sidebar-title').textContent = 'Direct messages';
  $('server-menu-btn').hidden = true;
  paintRail();
  paintChannels();
  if (state.dms.length) openChannel(state.dms[0].id);
  else showNoDMs();
}

function showNoDMs() {
  state.activeChannel = null;
  $('header-icon').textContent = '@';
  $('header-title').textContent = 'Direct messages';
  $('messages').innerHTML =
    '<div class="msg-empty">No conversations yet.<br>Use <b>New DM</b> in the sidebar to start one.</div>';
  $('msg-input').disabled = true;
  $('msg-input').placeholder = 'Pick a conversation first';
  $('members-body').innerHTML = '';
}

var lastChannelKey = null;

function paintChannels() {
  var host = $('channel-list');
  var key = 'srv:' + state.activeServer;
  host.classList.toggle('no-anim', key === lastChannelKey);
  lastChannelKey = key;
  host.innerHTML = '';
  var server = currentServer();

  if (!server) {
    var head = document.createElement('div');
    head.className = 'group-label';
    head.innerHTML = '<span>Direct messages</span><button title="New DM" aria-label="New DM">+</button>';
    head.querySelector('button').addEventListener('click', openDMModal);
    host.appendChild(head);

    if (!state.dms.length) {
      host.insertAdjacentHTML('beforeend',
        '<div class="side-empty">Nothing here yet. Hit + and enter a friend\'s username.</div>');
      return;
    }

    state.dms.forEach(function (d) {
      var el = document.createElement('div');
      el.className = 'channel' + (state.activeChannel === d.id ? ' active' : '');
      var unread = state.unread.get(d.id) || 0;
      el.innerHTML =
        '<span class="avatar" style="width:22px;height:22px;font-size:9px;background:' + esc(d.other.color) + '">' +
          esc(initials(d.other.display_name)) + '</span>' +
        '<span class="cname">' + esc(d.other.display_name) + '</span>' +
        '<span class="presence' + (state.online.has(d.other.id) ? ' on' : '') + '"></span>' +
        (unread ? '<span class="unread">' + unread + '</span>' : '');
      el.addEventListener('click', function () { openChannel(d.id); });
      host.appendChild(el);
    });
    return;
  }

  var isOwner = server.owner_id === state.me.id;
  var text = server.channels.filter(function (c) { return c.type === 'text'; });
  var voice = server.channels.filter(function (c) { return c.type === 'voice'; });

  [['Text channels', text, 'text'], ['Voice channels', voice, 'voice']].forEach(function (group) {
    var label = group[0], list = group[1], type = group[2];
    var head = document.createElement('div');
    head.className = 'group-label';
    head.innerHTML = '<span>' + label + '</span>' +
      (isOwner ? '<button title="Create channel" aria-label="Create ' + type + ' channel">+</button>' : '');
    var addBtn = head.querySelector('button');
    if (addBtn) addBtn.addEventListener('click', function () { openChannelModal(type); });
    host.appendChild(head);

    if (!list.length) {
      host.insertAdjacentHTML('beforeend', '<div class="side-empty">None yet.</div>');
      return;
    }

    list.forEach(function (c) {
      var el = document.createElement('div');
      el.className = 'channel' + (state.activeChannel === c.id && c.type === 'text' ? ' active' : '') +
        (state.voice.channelId === c.id ? ' active' : '');
      var unread = state.unread.get(c.id) || 0;
      el.innerHTML =
        '<span class="hash">' + (c.type === 'voice' ? '◉' : '#') + '</span>' +
        '<span class="cname">' + esc(c.name) + '</span>' +
        (unread && c.type === 'text' ? '<span class="unread">' + unread + '</span>' : '') +
        (isOwner ? '<button class="del" title="Delete channel" aria-label="Delete channel">✕</button>' : '');

      el.addEventListener('click', function (e) {
        if (e.target.classList.contains('del')) { e.stopPropagation(); confirmDeleteChannel(c); return; }
        if (c.type === 'voice') joinVoice(c.id); else openChannel(c.id);
      });
      host.appendChild(el);

      if (c.type === 'voice') {
        var members = state.voice.members.get(c.id) || [];
        if (members.length) {
          var box = document.createElement('div');
          box.className = 'voice-members';
          members.forEach(function (u) {
            var row = document.createElement('div');
            row.className = 'voice-member' + (state.voice.speaking.has(u.id) ? ' speaking' : '');
            row.innerHTML =
              '<span class="avatar" style="width:20px;height:20px;font-size:9px;background:' + esc(u.color) + '">' +
                esc(initials(u.display_name)) + '</span>' +
              '<span class="vm-name">' + esc(u.display_name) + '</span>' +
              (u.deafened ? '<span class="vm-flag">deafened</span>' : u.muted ? '<span class="vm-flag">muted</span>' : '');
            box.appendChild(row);
          });
          host.appendChild(box);
        }
      }
    });
  });
}

/* =========================================================== channels == */

async function openChannel(id) {
  var ch = findChannel(id);
  if (!ch) return;

  state.activeChannel = id;
  state.replyTo = null;
  state.editing = null;
  state.unread.delete(id);
  $('reply-bar').hidden = true;
  $('msg-input').disabled = false;

  try { localStorage.setItem('huddle:last', JSON.stringify({ server: state.activeServer, channel: id })); } catch (e) {}

  $('header-icon').textContent = ch.type === 'dm' ? '@' : '#';
  $('header-title').textContent = ch.name;
  $('msg-input').placeholder = 'Message ' + (ch.type === 'dm' ? ch.name : '#' + ch.name);
  $('app').classList.add('show-chat');

  paintChannels();
  paintRail();
  paintMembers();

  $('messages').innerHTML = skeletonHTML();
  try {
    var data = await api('GET', '/channels/' + id + '/messages');
    if (state.activeChannel !== id) return;
    state.messages = data.messages;
    state.hasMore = data.messages.length === 50;
    paintMessages(true);
    replayViewIn();
  } catch (e) {
    $('messages').innerHTML = '<div class="msg-empty">' + esc(e.message) + '</div>';
  }
}

async function loadOlder() {
  if (!state.messages.length) return;
  var oldest = state.messages[0].id;
  var box = $('messages');
  var prevHeight = box.scrollHeight;
  try {
    var data = await api('GET', '/channels/' + state.activeChannel + '/messages?before=' + oldest);
    state.messages = data.messages.concat(state.messages);
    state.hasMore = data.messages.length === 50;
    paintMessages(false);
    box.scrollTop = box.scrollHeight - prevHeight;
  } catch (e) { toast(e.message, true); }
}

/* =========================================================== messages == */

/** Restart the pane's entrance animation — retriggering needs a reflow. */
function replayViewIn() {
  var box = $('messages');
  box.classList.remove('view-in');
  void box.offsetWidth;
  box.classList.add('view-in');
}

function skeletonHTML() {
  var widths = ['62%', '78%', '44%', '86%', '55%'];
  return '<div class="skeleton">' + widths.map(function (w, i) {
    return '<div class="sk-row" style="animation-delay:' + (i * 60) + 'ms">' +
      '<div class="sk-av"></div><div class="sk-body">' +
      '<div class="sk-line" style="width:22%"></div>' +
      '<div class="sk-line" style="width:' + w + '"></div></div></div>';
  }).join('') + '</div>';
}

function paintMessages(scrollToEnd) {
  var box = $('messages');
  var ch = findChannel(state.activeChannel);
  var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;

  var html = '';

  if (!state.hasMore && ch) {
    html += '<div class="channel-intro">' +
      '<div class="big">' + (ch.type === 'dm' ? '@' : '#') + '</div>' +
      '<h2>' + (ch.type === 'dm' ? esc(ch.name) : 'Welcome to #' + esc(ch.name)) + '</h2>' +
      '<p>' + (ch.type === 'dm'
        ? 'This is the start of your conversation with ' + esc(ch.name) + '.'
        : 'This is the beginning of the #' + esc(ch.name) + ' channel.') + '</p></div>';
  } else if (state.hasMore) {
    html += '<button class="load-more" id="load-more">Load earlier messages</button>';
  }

  if (!state.messages.length) {
    html += '<div class="msg-empty">No messages yet — say something.</div>';
  }

  var prev = null;
  state.messages.forEach(function (m) {
    if (!prev || !sameDay(prev.created_at, m.created_at)) {
      html += '<div class="day-sep">' + esc(dayLabel(m.created_at)) + '</div>';
      prev = null;
    }
    html += messageHTML(m, prev);
    prev = m;
  });

  box.innerHTML = html;

  var lm = $('load-more');
  if (lm) lm.addEventListener('click', loadOlder);

  wireMessageEvents();
  var arrived = state.justArrived.size > 0;
  state.justArrived.clear();

  if (scrollToEnd) {
    box.scrollTop = box.scrollHeight;            // channel open: no travel
  } else if (atBottom) {
    if (arrived && typeof box.scrollTo === 'function') {
      box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    } else {
      box.scrollTop = box.scrollHeight;
    }
  }
}

function messageHTML(m, prev) {
  if (m.kind === 'system') {
    return '<div class="msg system' + (state.justArrived.has(m.id) ? ' is-new' : '') + '" data-id="' + m.id + '">' +
      '<div class="gutter"></div><div class="body">' + esc(m.content || 'Message removed.') + '</div></div>';
  }

  var isNew = state.justArrived.has(m.id) ? ' is-new' : '';

  var grouped = prev && prev.kind === 'user' &&
    prev.user_id === m.user_id && !m.reply_to &&
    (m.created_at - prev.created_at) < 7 * 60 * 1000;

  var mine = m.user_id === state.me.id;
  var canDelete = mine || isServerOwnerOfActive();

  var actions =
    '<div class="msg-actions">' +
      '<button class="icon-btn" data-act="react" title="Add reaction">☺</button>' +
      '<button class="icon-btn" data-act="reply" title="Reply">↩</button>' +
      (mine && !m.deleted ? '<button class="icon-btn" data-act="edit" title="Edit">✎</button>' : '') +
      (canDelete && !m.deleted ? '<button class="icon-btn danger" data-act="delete" title="Delete">🗑</button>' : '') +
    '</div>';

  var textHTML = m.deleted
    ? '<div class="text deleted">This message was deleted.</div>'
    : '<div class="text">' + renderText(m.content) + (m.edited_at ? '<span class="edited">(edited)</span>' : '') + '</div>';

  var reactions = '';
  if (m.reactions.length || !m.deleted) {
    var chips = m.reactions.map(function (r) {
      var mineR = r.users.indexOf(state.me.id) !== -1;
      return '<button class="reaction' + (mineR ? ' mine' : '') + '" data-act="toggle-react" data-emoji="' +
        esc(r.emoji) + '">' + esc(r.emoji) + '<span class="n">' + r.count + '</span></button>';
    }).join('');
    if (chips) {
      reactions = '<div class="reactions">' + chips +
        '<button class="reaction add" data-act="react" title="Add reaction">＋</button></div>';
    }
  }

  var replyRef = '';
  if (m.reply_to) {
    replyRef = '<div class="reply-ref"><b>' + esc(m.reply_to.author) + '</b><span>' +
      (m.reply_to.content === null ? 'message deleted' : esc(m.reply_to.content.slice(0, 120))) + '</span></div>';
  }

  if (grouped) {
    return '<div class="msg grouped' + isNew + '" data-id="' + m.id + '">' + actions +
      '<div class="hover-time">' + esc(timeOf(m.created_at)) + '</div>' +
      '<div class="gutter"></div>' +
      '<div class="body">' + textHTML + reactions + '</div></div>';
  }

  return '<div class="msg' + (prev ? ' gap' : '') + isNew + '" data-id="' + m.id + '">' + actions +
    '<div class="gutter"><div class="avatar" style="background:' + esc(m.color) + '">' +
      esc(initials(m.author)) + '</div></div>' +
    '<div class="body">' + replyRef +
      '<div class="head"><span class="author" data-act="mention">' + esc(m.author) + '</span>' +
      '<span class="stamp">' + esc(timeOf(m.created_at)) + '</span></div>' +
      textHTML + reactions + '</div></div>';
}

function isServerOwnerOfActive() {
  var s = currentServer();
  return !!s && s.owner_id === state.me.id;
}

function wireMessageEvents() {
  $('messages').querySelectorAll('.msg').forEach(function (el) {
    var id = Number(el.dataset.id);
    el.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.dataset.act;
      var m = state.messages.find(function (x) { return x.id === id; });
      if (!m) return;

      if (act === 'reply') startReply(m);
      else if (act === 'edit') startEdit(m, el);
      else if (act === 'delete') confirmDeleteMessage(m);
      else if (act === 'react') openEmojiPicker(m, btn);
      else if (act === 'toggle-react') toggleReaction(m.id, btn.dataset.emoji);
      else if (act === 'mention') insertMention(m.username);
    });
  });
}

function startReply(m) {
  if (m.deleted) return;
  state.replyTo = m;
  $('reply-to-name').textContent = m.author;
  $('reply-bar').hidden = false;
  $('msg-input').focus();
}

$('reply-cancel').addEventListener('click', function () {
  state.replyTo = null;
  $('reply-bar').hidden = true;
});

function insertMention(username) {
  if (!username) return;
  var input = $('msg-input');
  input.value = (input.value ? input.value.replace(/\s*$/, ' ') : '') + '@' + username + ' ';
  input.focus();
  autosize();
}

function startEdit(m, el) {
  var body = el.querySelector('.body');
  var original = body.innerHTML;
  state.editing = m.id;

  var box = document.createElement('div');
  box.className = 'edit-box';
  box.innerHTML = '<textarea rows="1"></textarea>' +
    '<div class="edit-hint">escape to <b data-x="cancel">cancel</b> · enter to <b data-x="save">save</b></div>';
  body.innerHTML = '';
  body.appendChild(box);

  var ta = box.querySelector('textarea');
  ta.value = m.content;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  function cancel() { state.editing = null; body.innerHTML = original; wireMessageEvents(); }

  async function save() {
    var content = ta.value.trim();
    if (!content) { confirmDeleteMessage(m); return; }
    if (content === m.content) { cancel(); return; }

    // Clear the guard first: the websocket echo can land before this await
    // resolves, and message_update skips repainting the message being edited.
    state.editing = null;
    try {
      await api('PATCH', '/messages/' + m.id, { content: content });
      paintMessages(false);
    } catch (e) {
      toast(e.message, true);
      state.editing = m.id;
      cancel();
    }
  }

  ta.addEventListener('input', function () {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  });
  ta.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
  });
  box.querySelector('[data-x="cancel"]').addEventListener('click', cancel);
  box.querySelector('[data-x="save"]').addEventListener('click', save);
}

function confirmDeleteMessage(m) {
  openModal('Delete message', function (body, close) {
    body.innerHTML = '<p class="hint">This can\'t be undone. The message will show as deleted for everyone.</p>' +
      '<div class="msg" style="background:rgba(0,0,0,0.18);border-radius:7px;margin-top:14px;padding:10px 12px">' +
      '<div class="body"><div class="head"><span class="author">' + esc(m.author) + '</span></div>' +
      '<div class="text">' + renderText(m.content || '') + '</div></div></div>' +
      '<div class="modal-actions"><button class="btn subtle" data-x="cancel">Cancel</button>' +
      '<button class="btn danger" data-x="ok">Delete</button></div>';
    body.querySelector('[data-x="cancel"]').addEventListener('click', close);
    body.querySelector('[data-x="ok"]').addEventListener('click', async function () {
      try { await api('DELETE', '/messages/' + m.id); } catch (e) { toast(e.message, true); }
      close();
    });
  });
}

async function toggleReaction(id, emoji) {
  try { await api('PUT', '/messages/' + id + '/reactions', { emoji: emoji }); }
  catch (e) { toast(e.message, true); }
}

function openEmojiPicker(m, anchor) {
  var menu = $('ctx-menu');
  menu.innerHTML = '<div class="picker">' + EMOJI.map(function (e) {
    return '<button data-e="' + e + '">' + e + '</button>';
  }).join('') + '</div>';
  menu.hidden = false;

  var r = anchor.getBoundingClientRect();
  var w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(r.left - w + r.width, window.innerWidth - w - 8)) + 'px';
  menu.style.top = (r.top - h - 6 < 8 ? r.bottom + 6 : r.top - h - 6) + 'px';

  menu.querySelectorAll('[data-e]').forEach(function (b) {
    b.addEventListener('click', function () {
      toggleReaction(m.id, b.dataset.e);
      closeCtx();
    });
  });
}

function closeCtx() { $('ctx-menu').hidden = true; }

document.addEventListener('click', function (e) {
  if (!$('ctx-menu').hidden && !e.target.closest('#ctx-menu') && !e.target.closest('[data-act="react"]')) closeCtx();
});
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeCtx(); });

/* =========================================================== composer == */

var input = $('msg-input');

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 190) + 'px';
}

input.addEventListener('input', function () {
  autosize();
  sendTyping();
});

input.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('msg-form').requestSubmit();
  }
  if (e.key === 'ArrowUp' && !input.value && !state.editing) {
    var mine = state.messages.filter(function (m) {
      return m.user_id === state.me.id && !m.deleted && m.kind === 'user';
    });
    var last = mine[mine.length - 1];
    if (last) {
      var el = $('messages').querySelector('.msg[data-id="' + last.id + '"]');
      if (el) { e.preventDefault(); startEdit(last, el); }
    }
  }
});

$('msg-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  var content = input.value.trim();
  if (!content || !state.activeChannel) return;

  var replyTo = state.replyTo ? state.replyTo.id : null;
  input.value = '';
  autosize();
  state.replyTo = null;
  $('reply-bar').hidden = true;

  try {
    await api('POST', '/channels/' + state.activeChannel + '/messages',
      { content: content, reply_to: replyTo });
    // Sending clears the typing state, so let the next keystroke signal again.
    lastTypingSent = 0;
  } catch (ex) {
    toast(ex.message, true);
    input.value = content;
    autosize();
  }
});

var lastTypingSent = 0;
function sendTyping() {
  var now = Date.now();
  if (now - lastTypingSent < 2500 || !state.activeChannel) return;
  lastTypingSent = now;
  wsSend({ t: 'typing', channel_id: state.activeChannel });
}

function paintTyping() {
  var now = Date.now();
  var names = [];
  state.typing.forEach(function (v, k) {
    if (v.expires > now && v.channel === state.activeChannel) names.push(v.name);
    else if (v.expires <= now) state.typing.delete(k);
  });

  var el = $('typing-text');
  if (!names.length) { el.innerHTML = ''; return; }
  var DOTS = '<span class="dots"><i></i><i></i><i></i></span>';
  if (names.length === 1) el.innerHTML = '<span><b>' + esc(names[0]) + '</b> is typing</span>' + DOTS;
  else if (names.length === 2) el.innerHTML = '<span><b>' + esc(names[0]) + '</b> and <b>' + esc(names[1]) + '</b> are typing</span>' + DOTS;
  else el.innerHTML = '<span><b>' + names.length + ' people</b> are typing</span>' + DOTS;
}
setInterval(paintTyping, 1000);

/* ============================================================ members == */

var lastMemberKey = null;

function paintMembers() {
  var host = $('members-body');
  var mKey = 'srv:' + state.activeServer + '|ch:' + state.activeChannel;
  host.classList.toggle('no-anim', mKey === lastMemberKey);
  lastMemberKey = mKey;
  var server = currentServer();
  var ch = findChannel(state.activeChannel);

  if (!server) {
    if (!ch || ch.type !== 'dm') { host.innerHTML = ''; return; }
    host.innerHTML = '<div class="group-label">Conversation</div>' +
      memberHTML(ch.other) + memberHTML(state.me);
    wireMemberEvents();
    return;
  }

  var online = server.members.filter(function (m) { return state.online.has(m.id) || m.id === state.me.id; });
  var offline = server.members.filter(function (m) { return !state.online.has(m.id) && m.id !== state.me.id; });

  var html = '';
  html += '<div class="group-label">Online — ' + online.length + '</div>';
  html += online.map(function (m) { return memberHTML(m); }).join('') || '<div class="side-empty">Nobody.</div>';
  if (offline.length) {
    html += '<div class="group-label">Offline — ' + offline.length + '</div>';
    html += offline.map(function (m) { return memberHTML(m); }).join('');
  }
  host.innerHTML = html;
  wireMemberEvents();
}

function memberHTML(u) {
  var on = state.online.has(u.id) || u.id === state.me.id;
  return '<div class="member ' + (on ? 'online' : 'offline') + '" data-uid="' + u.id +
    '" data-username="' + esc(u.username) + '">' +
    '<div class="wrap"><div class="avatar" style="background:' + esc(u.color) + '">' +
      esc(initials(u.display_name)) + '</div><span class="dot"></span></div>' +
    '<div class="m-text"><div class="m-name">' + esc(u.display_name) +
      (u.id === state.me.id ? ' <span style="color:var(--text-faint);font-size:11px">(you)</span>' : '') + '</div>' +
    (u.status_text ? '<div class="m-status">' + esc(u.status_text) + '</div>' : '') +
    '</div></div>';
}

function wireMemberEvents() {
  $('members-body').querySelectorAll('.member').forEach(function (el) {
    el.addEventListener('click', function () {
      var uid = Number(el.dataset.uid);
      if (uid === state.me.id) { openSettings(); return; }
      openDMWith(el.dataset.username);
    });
  });
}

/* ============================================================= modals == */

function openModal(title, build) {
  var root = $('modal-root');
  $('modal-title').textContent = title;
  var body = $('modal-body');
  body.innerHTML = '';
  root.hidden = false;

  function close() { root.hidden = true; body.innerHTML = ''; }
  root.querySelectorAll('[data-close]').forEach(function (el) { el.onclick = close; });

  function onKey(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } }
  document.addEventListener('keydown', onKey);

  build(body, close);
  var first = body.querySelector('input, button');
  if (first) first.focus();
}

function openServerModal() {
  openModal('Add a server', function (body, close) {
    body.innerHTML =
      '<div class="type-row">' +
        '<button class="type-opt on" data-t="create"><b>Create</b><span>Start a new server</span></button>' +
        '<button class="type-opt" data-t="join"><b>Join</b><span>Use an invite code</span></button>' +
      '</div>' +
      '<div data-pane="create"><label for="m-name">Server name</label>' +
        '<input id="m-name" maxlength="40" placeholder="Friday Night Crew"></div>' +
      '<div data-pane="join" hidden><label for="m-code">Invite code</label>' +
        '<input id="m-code" maxlength="16" placeholder="4f8a21c9" style="font-family:ui-monospace,Menlo,monospace"></div>' +
      '<div class="err"></div>' +
      '<div class="modal-actions"><button class="btn subtle" data-x="cancel">Cancel</button>' +
        '<button class="btn primary" data-x="ok">Create server</button></div>';

    var mode = 'create';
    var err = body.querySelector('.err');
    var okBtn = body.querySelector('[data-x="ok"]');

    body.querySelectorAll('.type-opt').forEach(function (b) {
      b.addEventListener('click', function () {
        mode = b.dataset.t;
        body.querySelectorAll('.type-opt').forEach(function (x) { x.classList.toggle('on', x === b); });
        body.querySelector('[data-pane="create"]').hidden = mode !== 'create';
        body.querySelector('[data-pane="join"]').hidden = mode !== 'join';
        okBtn.textContent = mode === 'create' ? 'Create server' : 'Join server';
        err.textContent = '';
        body.querySelector(mode === 'create' ? '#m-name' : '#m-code').focus();
      });
    });

    body.querySelector('[data-x="cancel"]').addEventListener('click', close);

    async function submit() {
      err.textContent = '';
      okBtn.disabled = true;
      try {
        var res = mode === 'create'
          ? await api('POST', '/servers', { name: body.querySelector('#m-name').value.trim() })
          : await api('POST', '/servers/join', { code: body.querySelector('#m-code').value.trim() });
        await loadServers();
        close();
        selectServer(res.server.id);
        toast(mode === 'create' ? 'Server created.' : (res.already ? "You're already in that server." : 'Joined ' + res.server.name + '.'));
      } catch (e) {
        err.textContent = e.message;
      } finally { okBtn.disabled = false; }
    }

    okBtn.addEventListener('click', submit);
    body.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  });
}

function openChannelModal(type) {
  openModal('Create ' + (type === 'voice' ? 'voice' : 'text') + ' channel', function (body, close) {
    body.innerHTML =
      '<label for="c-name">Channel name</label>' +
      '<input id="c-name" maxlength="24" placeholder="' + (type === 'voice' ? 'Lounge' : 'plans') + '">' +
      '<p class="hint" style="margin-top:8px">Spaces become dashes. Lowercase only.</p>' +
      '<div class="err"></div>' +
      '<div class="modal-actions"><button class="btn subtle" data-x="cancel">Cancel</button>' +
      '<button class="btn primary" data-x="ok">Create</button></div>';

    var err = body.querySelector('.err');
    body.querySelector('[data-x="cancel"]').addEventListener('click', close);

    async function submit() {
      try {
        await api('POST', '/servers/' + state.activeServer + '/channels',
          { name: body.querySelector('#c-name').value, type: type });
        await loadServers();
        paintChannels();
        close();
      } catch (e) { err.textContent = e.message; }
    }
    body.querySelector('[data-x="ok"]').addEventListener('click', submit);
    body.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  });
}

function confirmDeleteChannel(c) {
  openModal('Delete #' + c.name, function (body, close) {
    body.innerHTML = '<p class="hint">Every message in <b>#' + esc(c.name) +
      '</b> goes with it. This can\'t be undone.</p>' +
      '<div class="err"></div>' +
      '<div class="modal-actions"><button class="btn subtle" data-x="cancel">Cancel</button>' +
      '<button class="btn danger" data-x="ok">Delete channel</button></div>';
    body.querySelector('[data-x="cancel"]').addEventListener('click', close);
    body.querySelector('[data-x="ok"]').addEventListener('click', async function () {
      try {
        await api('DELETE', '/channels/' + c.id);
        await loadServers();
        close();
        selectServer(state.activeServer);
      } catch (e) { body.querySelector('.err').textContent = e.message; }
    });
  });
}

function openDMModal() {
  openModal('New direct message', function (body, close) {
    body.innerHTML =
      '<label for="d-user">Username</label>' +
      '<input id="d-user" maxlength="20" placeholder="mina" autocomplete="off">' +
      '<div id="d-results" style="margin-top:10px"></div>' +
      '<div class="err"></div>' +
      '<div class="modal-actions"><button class="btn subtle" data-x="cancel">Cancel</button>' +
      '<button class="btn primary" data-x="ok">Start conversation</button></div>';

    var field = body.querySelector('#d-user');
    var results = body.querySelector('#d-results');
    var err = body.querySelector('.err');
    var timer;

    field.addEventListener('input', function () {
      clearTimeout(timer);
      var q = field.value.trim();
      if (q.length < 1) { results.innerHTML = ''; return; }
      timer = setTimeout(async function () {
        try {
          var data = await api('GET', '/users/search?q=' + encodeURIComponent(q));
          results.innerHTML = data.users.map(function (u) {
            return '<div class="member" data-u="' + esc(u.username) + '">' +
              '<div class="wrap"><div class="avatar" style="background:' + esc(u.color) + '">' +
              esc(initials(u.display_name)) + '</div></div>' +
              '<div class="m-text"><div class="m-name">' + esc(u.display_name) + '</div>' +
              '<div class="m-status">@' + esc(u.username) + '</div></div></div>';
          }).join('') || '<div class="side-empty">No matches.</div>';
          results.querySelectorAll('[data-u]').forEach(function (el) {
            el.addEventListener('click', function () { go(el.dataset.u); });
          });
        } catch (e) {}
      }, 220);
    });

    async function go(username) {
      try {
        var data = await api('POST', '/dms', { username: username || field.value.trim() });
        await loadDMs();
        close();
        selectDMs();
        openChannel(data.dm.id);
      } catch (e) { err.textContent = e.message; }
    }

    body.querySelector('[data-x="cancel"]').addEventListener('click', close);
    body.querySelector('[data-x="ok"]').addEventListener('click', function () { go(); });
    field.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  });
}

async function openDMWith(username) {
  try {
    var data = await api('POST', '/dms', { username: username });
    await loadDMs();
    selectDMs();
    openChannel(data.dm.id);
  } catch (e) { toast(e.message, true); }
}

var PALETTE = ['#e4e4e2', '#cdd8dd', '#d3ddd0', '#e0d4d8', '#d5d3e0',
               '#e2dcd0', '#cfdcd8', '#ddd6cd', '#d8dce0', '#dcd8d2'];

function openSettings() {
  openModal('Your profile', function (body, close) {
    body.innerHTML =
      '<label for="s-name">Display name</label>' +
      '<input id="s-name" maxlength="32" value="' + esc(state.me.display_name) + '">' +
      '<label for="s-status">Status</label>' +
      '<input id="s-status" maxlength="60" placeholder="Up to something" value="' + esc(state.me.status_text || '') + '">' +
      '<label>Avatar colour</label>' +
      '<div class="color-row">' + PALETTE.map(function (c) {
        return '<button class="swatch' + (c === state.me.color ? ' on' : '') + '" data-c="' + c +
          '" style="background:' + c + '" aria-label="' + c + '"></button>';
      }).join('') + '</div>' +
      '<p class="hint" style="margin-top:16px">Signed in as <b>@' + esc(state.me.username) + '</b>.</p>' +
      '<div class="err"></div>' +
      '<div class="modal-actions">' +
        '<button class="btn subtle" data-x="logout">Sign out</button>' +
        '<div style="flex:1"></div>' +
        '<button class="btn subtle" data-x="cancel">Cancel</button>' +
        '<button class="btn primary" data-x="ok">Save</button></div>';

    var color = state.me.color;
    body.querySelectorAll('.swatch').forEach(function (b) {
      b.addEventListener('click', function () {
        color = b.dataset.c;
        body.querySelectorAll('.swatch').forEach(function (x) { x.classList.toggle('on', x === b); });
      });
    });

    body.querySelector('[data-x="cancel"]').addEventListener('click', close);
    body.querySelector('[data-x="logout"]').addEventListener('click', async function () {
      await api('POST', '/logout');
      location.reload();
    });
    body.querySelector('[data-x="ok"]').addEventListener('click', async function () {
      try {
        var data = await api('PATCH', '/me', {
          display_name: body.querySelector('#s-name').value.trim(),
          status_text: body.querySelector('#s-status').value.trim(),
          color: color
        });
        state.me = data.user;
        paintMe();
        close();
        toast('Profile updated.');
      } catch (e) { body.querySelector('.err').textContent = e.message; }
    });
  });
}

$('btn-settings').addEventListener('click', openSettings);

$('server-menu-btn').addEventListener('click', function () {
  var s = currentServer();
  if (!s) return;
  openModal(s.name, function (body, close) {
    body.innerHTML =
      (s.invite_code
        ? '<label>Invite code</label><p class="hint">Anyone with this code can join. Share it carefully.</p>' +
          '<div class="invite-row"><input id="inv" readonly value="' + esc(s.invite_code) + '">' +
          '<button class="btn primary" data-x="copy">Copy</button></div>'
        : '<p class="hint">Ask the server owner for the invite code if you want to bring someone in.</p>') +
      '<label>Members</label><p class="hint">' + s.members.length + ' member' + (s.members.length === 1 ? '' : 's') + '.</p>' +
      '<div class="modal-actions"><button class="btn subtle" data-x="cancel">Close</button></div>';

    body.querySelector('[data-x="cancel"]').addEventListener('click', close);
    var copy = body.querySelector('[data-x="copy"]');
    if (copy) copy.addEventListener('click', function () {
      var field = body.querySelector('#inv');
      field.select();
      navigator.clipboard.writeText(field.value).then(
        function () { toast('Invite code copied.'); },
        function () { toast('Press ⌘/Ctrl+C to copy.', true); }
      );
    });
  });
});

/* ========================================================== websocket == */

function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

function connectWS() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var ws = new WebSocket(proto + '//' + location.host + '/ws');
  state.ws = ws;

  ws.onopen = function () { state.wsRetry = 0; };

  ws.onmessage = function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handleWS(msg);
  };

  ws.onclose = function () {
    state.ws = null;
    var delay = Math.min(30000, 1000 * Math.pow(2, state.wsRetry++));
    setTimeout(connectWS, delay);
  };

  ws.onerror = function () { try { ws.close(); } catch (e) {} };
}

function handleWS(msg) {
  switch (msg.t) {
    case 'ready':
      state.online = new Set(msg.online);
      paintMembers();
      paintChannels();
      break;

    case 'presence':
      if (msg.online) state.online.add(msg.user_id); else state.online.delete(msg.user_id);
      paintMembers();
      paintChannels();
      break;

    case 'presence_snapshot':
      state.online = new Set(msg.online);
      paintMembers();
      paintChannels();
      break;

    case 'user_update':
      state.servers.forEach(function (s) {
        var i = s.members.findIndex(function (m) { return m.id === msg.user.id; });
        if (i >= 0) s.members[i] = msg.user;
      });
      state.messages.forEach(function (m) {
        if (m.user_id === msg.user.id) { m.author = msg.user.display_name; m.color = msg.user.color; }
      });
      if (msg.user.id === state.me.id) { state.me = msg.user; paintMe(); }
      paintMembers();
      paintMessages(false);
      break;

    case 'message':
      onIncomingMessage(msg.message);
      break;

    case 'message_update': {
      var i = state.messages.findIndex(function (m) { return m.id === msg.message.id; });
      if (i >= 0 && msg.message.channel_id === state.activeChannel) {
        state.messages[i] = msg.message;
        if (state.editing !== msg.message.id) paintMessages(false);
      }
      break;
    }

    case 'typing':
      if (msg.user_id === state.me.id) break;
      state.typing.set(msg.user_id, {
        name: msg.display_name, channel: msg.channel_id, expires: Date.now() + 6000
      });
      paintTyping();
      break;

    case 'server_update':
      loadServers().then(function () { paintChannels(); paintMembers(); });
      break;

    case 'dm_created':
      loadDMs().then(function () { if (state.activeServer === null) paintChannels(); });
      break;

    case 'voice_state':
      state.voice.members.set(msg.channel_id, msg.users);
      if (state.voice.channelId === msg.channel_id) syncVoicePeers(msg.users);
      paintChannels();
      break;

    case 'rtc_init':
      msg.peers.forEach(function (peerId) { createPeer(peerId, true); });
      break;

    case 'rtc_signal':
      handleSignal(msg.from, msg.signal);
      break;

    case 'rtc_peer_left':
      dropPeer(msg.user_id);
      break;
  }
}

function onIncomingMessage(m) {
  if (m.channel_id === state.activeChannel) {
    state.justArrived.add(m.id);
    state.messages.push(m);
    if (state.messages.length > 300) state.messages = state.messages.slice(-300);
    state.typing.delete(m.user_id);
    paintTyping();
    paintMessages(false);
  } else {
    state.unread.set(m.channel_id, (state.unread.get(m.channel_id) || 0) + 1);
    paintChannels();
    paintRail();
    if (m.user_id !== state.me.id) notify(m);
  }
}

function notify(m) {
  var ch = findChannel(m.channel_id);
  var mentioned = state.me && m.content &&
    m.content.toLowerCase().indexOf('@' + state.me.username.toLowerCase()) !== -1;
  if (!ch) return;
  if (ch.type === 'dm' || mentioned) {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      new Notification(m.author + (ch.type === 'dm' ? '' : ' in #' + ch.name), { body: m.content || '' });
    }
  }
}

if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
  document.addEventListener('click', function once() {
    Notification.requestPermission();
    document.removeEventListener('click', once);
  }, { once: true });
}

/* ============================================================== voice == */

async function joinVoice(channelId) {
  if (state.voice.channelId === channelId) return;
  if (state.voice.channelId != null) leaveVoice();

  try {
    state.voice.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    toast('Microphone access is required for voice channels.', true);
    return;
  }

  state.voice.channelId = channelId;
  state.voice.muted = false;
  state.voice.deafened = false;
  wsSend({ t: 'voice_join', channel_id: channelId });

  var ch = findChannel(channelId);
  $('vs-channel').textContent = ch ? ch.name : '';
  $('voice-status').hidden = false;
  $('btn-mute').setAttribute('aria-pressed', 'false');
  $('btn-mute').textContent = 'Mute';
  $('btn-deafen').setAttribute('aria-pressed', 'false');
  $('btn-deafen').textContent = 'Deafen';

  watchSpeaking(state.voice.stream, state.me.id);
  paintChannels();
}

function leaveVoice() {
  if (state.voice.channelId == null) return;
  wsSend({ t: 'voice_leave' });

  state.voice.peers.forEach(function (pc) { try { pc.close(); } catch (e) {} });
  state.voice.peers.clear();
  $('voice-audio').innerHTML = '';

  if (state.voice.stream) {
    state.voice.stream.getTracks().forEach(function (t) { t.stop(); });
    state.voice.stream = null;
  }

  state.voice.members.delete(state.voice.channelId);
  state.voice.channelId = null;
  state.voice.speaking.clear();
  $('voice-status').hidden = true;
  paintChannels();
}

$('vs-leave').addEventListener('click', leaveVoice);

$('btn-mute').addEventListener('click', function () {
  state.voice.muted = !state.voice.muted;
  if (!state.voice.muted && state.voice.deafened) toggleDeafen(false);
  applyMute();
});

$('btn-deafen').addEventListener('click', function () { toggleDeafen(!state.voice.deafened); });

function toggleDeafen(on) {
  state.voice.deafened = on;
  if (on) state.voice.muted = true;
  $('voice-audio').querySelectorAll('audio').forEach(function (a) { a.muted = on; });
  applyMute();
}

function applyMute() {
  if (state.voice.stream) {
    state.voice.stream.getAudioTracks().forEach(function (t) { t.enabled = !state.voice.muted; });
  }
  $('btn-mute').setAttribute('aria-pressed', String(state.voice.muted));
  $('btn-mute').textContent = state.voice.muted ? 'Unmute' : 'Mute';
  $('btn-deafen').setAttribute('aria-pressed', String(state.voice.deafened));
  $('btn-deafen').textContent = state.voice.deafened ? 'Undeafen' : 'Deafen';
  wsSend({ t: 'voice_update', muted: state.voice.muted, deafened: state.voice.deafened });
}

function syncVoicePeers(users) {
  var ids = users.map(function (u) { return u.id; }).filter(function (id) { return id !== state.me.id; });
  state.voice.peers.forEach(function (pc, id) { if (ids.indexOf(id) === -1) dropPeer(id); });
}

function createPeer(peerId, initiator) {
  if (state.voice.peers.has(peerId)) return state.voice.peers.get(peerId);

  var pc = new RTCPeerConnection(ICE);
  state.voice.peers.set(peerId, pc);

  if (state.voice.stream) {
    state.voice.stream.getTracks().forEach(function (t) { pc.addTrack(t, state.voice.stream); });
  }

  pc.onicecandidate = function (e) {
    if (e.candidate) wsSend({ t: 'rtc_signal', to: peerId, signal: { candidate: e.candidate } });
  };

  pc.ontrack = function (e) {
    var id = 'voice-peer-' + peerId;
    var audio = document.getElementById(id);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = id;
      audio.autoplay = true;
      audio.playsInline = true;
      $('voice-audio').appendChild(audio);
    }
    audio.srcObject = e.streams[0];
    audio.muted = state.voice.deafened;
    watchSpeaking(e.streams[0], peerId);
  };

  pc.onconnectionstatechange = function () {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropPeer(peerId);
  };

  if (initiator) {
    pc.createOffer()
      .then(function (offer) { return pc.setLocalDescription(offer); })
      .then(function () { wsSend({ t: 'rtc_signal', to: peerId, signal: { sdp: pc.localDescription } }); })
      .catch(function (e) { console.error('offer failed', e); });
  }

  return pc;
}

async function handleSignal(from, signal) {
  var pc = state.voice.peers.get(from) || createPeer(from, false);

  try {
    if (signal.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      if (signal.sdp.type === 'offer') {
        var answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        wsSend({ t: 'rtc_signal', to: from, signal: { sdp: pc.localDescription } });
      }
    } else if (signal.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  } catch (e) {
    console.error('signal error', e);
  }
}

function dropPeer(peerId) {
  var pc = state.voice.peers.get(peerId);
  if (pc) { try { pc.close(); } catch (e) {} state.voice.peers.delete(peerId); }
  var audio = document.getElementById('voice-peer-' + peerId);
  if (audio) audio.remove();
  state.voice.speaking.delete(peerId);
  stopWatching(peerId);
}

/* --- speaking detection ------------------------------------------------ */

var audioCtx = null;
var watchers = new Map();

function watchSpeaking(stream, userId) {
  stopWatching(userId);
  if (!stream.getAudioTracks().length) return;

  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    var source = audioCtx.createMediaStreamSource(stream);
    var analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);

    var data = new Uint8Array(analyser.frequencyBinCount);
    var raf;

    (function tick() {
      analyser.getByteFrequencyData(data);
      var sum = 0;
      for (var i = 0; i < data.length; i++) sum += data[i];
      var level = sum / data.length;

      var speaking = level > 12 && !(userId === state.me.id && state.voice.muted);
      var was = state.voice.speaking.has(userId);
      if (speaking !== was) {
        if (speaking) state.voice.speaking.add(userId); else state.voice.speaking.delete(userId);
        paintChannels();
      }
      raf = requestAnimationFrame(tick);
    })();

    watchers.set(userId, function () {
      cancelAnimationFrame(raf);
      try { source.disconnect(); } catch (e) {}
    });
  } catch (e) { /* analysis is a nicety, not a requirement */ }
}

function stopWatching(userId) {
  var stop = watchers.get(userId);
  if (stop) { stop(); watchers.delete(userId); }
}

window.addEventListener('beforeunload', function () { if (state.voice.channelId != null) leaveVoice(); });

/* ============================================================= mobile == */

$('btn-back').addEventListener('click', function () { $('app').classList.remove('show-chat'); });
$('btn-members-toggle').addEventListener('click', function () { $('members').classList.toggle('open'); });

/* ============================================================== start == */

boot();

})();
