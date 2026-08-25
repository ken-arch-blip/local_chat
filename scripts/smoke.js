/* End-to-end smoke test against a running server. Not shipped as a dependency —
   run with:  node scripts/smoke.js [baseUrl] */
const WebSocket = require('ws');

const BASE = process.argv[2] || 'http://localhost:3010';
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}

function makeClient() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async call(method, path, body) {
      const res = await fetch(BASE + '/api' + path, {
        method,
        headers: Object.assign({}, body ? { 'Content-Type': 'application/json' } : {}, cookie ? { cookie } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let data = null;
      try { data = await res.json(); } catch (e) {}
      return { status: res.status, data };
    },
  };
}

function wsFor(client) {
  return new WebSocket(BASE.replace('http', 'ws') + '/ws', { headers: { cookie: client.cookie } });
}

function waitFor(ws, predicate, ms = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error('timeout waiting for event')); }, ms);
    function onMsg(raw) {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (predicate(m)) { clearTimeout(timer); ws.off('message', onMsg); resolve(m); }
    }
    ws.on('message', onMsg);
  });
}

(async () => {
  const stamp = Date.now().toString(36);
  const alice = makeClient();
  const bob = makeClient();

  console.log('\nAuth');
  let r = await alice.call('POST', '/register', { username: 'alice' + stamp, password: 'hunter22', display_name: 'Alice A' });
  ok('register alice', r.status === 200 && r.data.user.username === 'alice' + stamp, r.data);

  r = await alice.call('POST', '/register', { username: 'alice' + stamp, password: 'hunter22' });
  ok('duplicate username rejected', r.status === 409, r.data);

  r = await alice.call('POST', '/register', { username: 'x', password: 'hunter22' });
  ok('short username rejected', r.status === 400, r.data);

  r = await alice.call('POST', '/register', { username: 'zz' + stamp, password: '123' });
  ok('short password rejected', r.status === 400, r.data);

  r = await bob.call('POST', '/register', { username: 'bob' + stamp, password: 'hunter22', display_name: 'Bob B' });
  ok('register bob', r.status === 200, r.data);
  const bobId = r.data.user.id;

  r = await alice.call('GET', '/me');
  ok('session cookie works', r.status === 200 && r.data.user.display_name === 'Alice A', r.data);

  const stranger = makeClient();
  r = await stranger.call('GET', '/me');
  ok('unauthenticated /me is 401', r.status === 401);

  console.log('\nServers and channels');
  r = await alice.call('POST', '/servers', { name: 'Test Crew' });
  ok('create server', r.status === 200 && r.data.server.channels.length === 3, r.data);
  const server = r.data.server;
  const invite = server.invite_code;
  const general = server.channels.find(c => c.name === 'general');
  const voiceCh = server.channels.find(c => c.type === 'voice');
  ok('server seeded with a voice channel', !!voiceCh, server.channels);
  ok('owner sees the invite code', !!invite);

  r = await bob.call('GET', '/channels/' + general.id + '/messages');
  ok('non-member blocked from channel', r.status === 403, r.data);

  r = await bob.call('POST', '/servers/join', { code: invite });
  ok('bob joins with invite code', r.status === 200, r.data);
  ok('non-owner gets no invite code', r.data.server.invite_code === undefined);

  r = await bob.call('POST', '/servers/join', { code: 'deadbeef' });
  ok('bad invite code rejected', r.status === 404);

  r = await bob.call('POST', '/servers/' + server.id + '/channels', { name: 'sneaky' });
  ok('non-owner cannot add channels', r.status === 403, r.data);

  r = await alice.call('POST', '/servers/' + server.id + '/channels', { name: 'Weekend Plans', type: 'text' });
  ok('owner adds channel, name slugified', r.status === 200 && r.data.channel.name === 'weekend-plans', r.data);
  const extraCh = r.data.channel;

  console.log('\nWebSocket + messaging');
  const aliceWS = wsFor(alice);
  const bobWS = wsFor(bob);
  await Promise.all([
    waitFor(aliceWS, m => m.t === 'ready'),
    waitFor(bobWS, m => m.t === 'ready'),
  ]);
  ok('both sockets ready', true);

  const bobGetsMessage = waitFor(bobWS, m => m.t === 'message' && m.message.content === 'hello world');
  r = await alice.call('POST', '/channels/' + general.id + '/messages', { content: 'hello world' });
  ok('post message', r.status === 200, r.data);
  const msgId = r.data.message.id;
  const pushed = await bobGetsMessage;
  ok('message pushed over websocket', pushed.message.author === 'Alice A', pushed.message);

  r = await alice.call('POST', '/channels/' + general.id + '/messages', { content: '   ' });
  ok('empty message rejected', r.status === 400);

  r = await alice.call('POST', '/channels/' + general.id + '/messages', { content: 'x'.repeat(2001) });
  ok('overlong message rejected', r.status === 400);

  console.log('\nReplies, edits, reactions, deletes');
  r = await bob.call('POST', '/channels/' + general.id + '/messages', { content: 'hi back', reply_to: msgId });
  ok('reply resolves parent', r.status === 200 && r.data.message.reply_to.author === 'Alice A', r.data.message);
  const replyId = r.data.message.id;

  r = await bob.call('POST', '/channels/' + general.id + '/messages', { content: 'cross-channel reply', reply_to: 999999 });
  ok('reply to a foreign message is dropped', r.status === 200 && r.data.message.reply_to === null, r.data.message);

  r = await bob.call('PATCH', '/messages/' + msgId, { content: 'nope' });
  ok("can't edit someone else's message", r.status === 403);

  const bobGetsEdit = waitFor(bobWS, m => m.t === 'message_update' && m.message.id === msgId && m.message.edited_at);
  r = await alice.call('PATCH', '/messages/' + msgId, { content: 'hello world (fixed)' });
  ok('edit own message', r.status === 200 && r.data.message.edited_at > 0, r.data.message);
  await bobGetsEdit;
  ok('edit pushed over websocket', true);

  r = await bob.call('PUT', '/messages/' + msgId + '/reactions', { emoji: '🔥' });
  ok('add reaction', r.data.message.reactions.length === 1 && r.data.message.reactions[0].count === 1, r.data.message.reactions);

  r = await alice.call('PUT', '/messages/' + msgId + '/reactions', { emoji: '🔥' });
  ok('second reaction increments count', r.data.message.reactions[0].count === 2, r.data.message.reactions);

  r = await bob.call('PUT', '/messages/' + msgId + '/reactions', { emoji: '🔥' });
  ok('reaction toggles off', r.data.message.reactions[0].count === 1, r.data.message.reactions);

  r = await alice.call('DELETE', '/messages/' + replyId);
  ok('server owner can delete any message', r.status === 200, r.data);

  r = await alice.call('GET', '/channels/' + general.id + '/messages');
  const tomb = r.data.messages.find(m => m.id === replyId);
  ok('deleted message is a tombstone', tomb && tomb.deleted === true && tomb.content === null, tomb);

  console.log('\nDirect messages');
  r = await alice.call('POST', '/dms', { username: 'bob' + stamp });
  ok('open DM', r.status === 200, r.data);
  const dmId = r.data.dm.id;

  r = await alice.call('POST', '/dms', { username: 'bob' + stamp });
  ok('reopening a DM returns the same channel', r.data.dm.id === dmId);

  r = await alice.call('POST', '/dms', { username: 'nobody-here' });
  ok('DM with unknown user rejected', r.status === 404);

  const bobGetsDM = waitFor(bobWS, m => m.t === 'message' && m.message.channel_id === dmId);
  await alice.call('POST', '/channels/' + dmId + '/messages', { content: 'psst' });
  await bobGetsDM;
  ok('DM delivered over websocket', true);

  const carol = makeClient();
  await carol.call('POST', '/register', { username: 'carol' + stamp, password: 'hunter22' });
  r = await carol.call('GET', '/channels/' + dmId + '/messages');
  ok('third party blocked from a DM', r.status === 403, r.data);

  console.log('\nTyping and presence');
  const bobGetsTyping = waitFor(bobWS, m => m.t === 'typing' && m.channel_id === general.id);
  aliceWS.send(JSON.stringify({ t: 'typing', channel_id: general.id }));
  const typing = await bobGetsTyping;
  ok('typing relayed to peers', typing.display_name === 'Alice A', typing);

  console.log('\nVoice signalling');
  const bobSeesVoice = waitFor(bobWS, m => m.t === 'voice_state' && m.channel_id === voiceCh.id && m.users.length === 1);
  aliceWS.send(JSON.stringify({ t: 'voice_join', channel_id: voiceCh.id }));
  const vs = await bobSeesVoice;
  ok('voice_state broadcast on join', vs.users[0].display_name === 'Alice A', vs.users);

  const aliceSeesTwo = waitFor(aliceWS, m => m.t === 'voice_state' && m.users.length === 2);
  const bobGetsInit = waitFor(bobWS, m => m.t === 'rtc_init');
  bobWS.send(JSON.stringify({ t: 'voice_join', channel_id: voiceCh.id }));
  const init = await bobGetsInit;
  ok('newcomer told to offer to existing peers', init.peers.length === 1, init.peers);
  await aliceSeesTwo;
  ok('room reports both members', true);

  const aliceGetsSignal = waitFor(aliceWS, m => m.t === 'rtc_signal');
  bobWS.send(JSON.stringify({ t: 'rtc_signal', to: vs.users[0].id, signal: { sdp: { type: 'offer', sdp: 'fake' } } }));
  const sig = await aliceGetsSignal;
  ok('rtc signal relayed to the right peer', sig.from === bobId, sig);

  const aliceSeesMute = waitFor(aliceWS, m => m.t === 'voice_state' && m.users.some(u => u.muted));
  bobWS.send(JSON.stringify({ t: 'voice_update', muted: true, deafened: false }));
  await aliceSeesMute;
  ok('mute state broadcast', true);

  const aliceSeesLeave = waitFor(aliceWS, m => m.t === 'voice_state' && m.users.length === 1);
  bobWS.send(JSON.stringify({ t: 'voice_leave' }));
  await aliceSeesLeave;
  ok('leaving voice updates the room', true);

  console.log('\nProfile and channel deletion');
  const bobSeesProfile = waitFor(bobWS, m => m.t === 'user_update' && m.user.display_name === 'Alice Renamed');
  r = await alice.call('PATCH', '/me', { display_name: 'Alice Renamed', color: '#23a55a', status_text: 'busy' });
  ok('update profile', r.status === 200 && r.data.user.color === '#23a55a', r.data);
  await bobSeesProfile;
  ok('profile change broadcast', true);

  r = await alice.call('PATCH', '/me', { color: 'red' });
  ok('invalid colour rejected', r.status === 400);

  r = await alice.call('DELETE', '/channels/' + extraCh.id);
  ok('owner deletes a channel', r.status === 200, r.data);

  r = await bob.call('DELETE', '/channels/' + general.id);
  ok('non-owner cannot delete a channel', r.status === 403, r.data);

  // Drain down to a single text channel, then confirm the guard holds.
  const randomCh = server.channels.find(c => c.name === 'random');
  r = await alice.call('DELETE', '/channels/' + randomCh.id);
  ok('owner deletes #random', r.status === 200, r.data);

  r = await alice.call('DELETE', '/channels/' + general.id);
  ok('cannot delete the last text channel', r.status === 400, r.data);

  r = await alice.call('DELETE', '/channels/' + voiceCh.id);
  ok('voice channels are not covered by that guard', r.status === 200, r.data);

  console.log('\nStatic pages');
  for (const [path, needle] of [['/', 'data-scroll-container'], ['/app.html', 'msg-form'], ['/vendor/locomotive-scroll.min.js', 'LocomotiveScroll'], ['/js/landing.js', 'LocomotiveScroll'], ['/css/app.css', '--cream'], ['/favicon.svg', 'svg']]) {
    const res = await fetch(BASE + path);
    const text = await res.text();
    ok('serves ' + path, res.status === 200 && text.includes(needle), res.status);
  }

  aliceWS.close(); bobWS.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nFATAL:', e); process.exit(1); });
