/* Huddle — landing page motion.
   Locomotive Scroll drives the parallax, the reveal calls and the sticky mock. */

(function () {
  'use strict';

  var container = document.querySelector('[data-scroll-container]');
  var nav = document.getElementById('nav');
  var progressBar = document.getElementById('progress-bar');
  var motionToggle = document.getElementById('motion-toggle');

  var STORAGE_KEY = 'huddle:reduced-motion';
  var prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var userDisabled = false;
  try { userDisabled = localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) {}

  var smooth = !prefersReduced && !userDisabled;
  var scroll = null;

  /* ------------------------------------------------------------ init -- */

  function init() {
    scroll = new LocomotiveScroll({
      el: container,
      smooth: smooth,
      lerp: 0.062,   // lower = longer, floatier glide
      multiplier: 1,
      class: 'is-inview',
      reloadOnContextChange: true,
      tablet: { smooth: smooth, breakpoint: 1024 },
      smartphone: { smooth: false }   // touch scrolling stays native
    });

    scroll.on('scroll', onScroll);
    scroll.on('call', onCall);

    // Handy from the console, and lets automated checks drive the page.
    window.huddleScroll = scroll;

    // Anchor links have to go through Locomotive, not the browser.
    document.querySelectorAll('a[href^="#"]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        var target = a.getAttribute('href');
        if (target.length < 2) return;
        var el = document.querySelector(target);
        if (!el) return;
        e.preventDefault();
        scroll.scrollTo(el, { offset: -70, duration: 1200, easing: [0.16, 1, 0.3, 1] });
      });
    });

    // Images and fonts settling late would leave stale trigger positions.
    window.addEventListener('load', function () { scroll.update(); });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { scroll.update(); });
    }
  }

  /* --------------------------------------------------------- handlers -- */

  var docHeight = 1;

  function onScroll(args) {
    var y = args.scroll.y;
    var limit = args.limit && args.limit.y ? args.limit.y : docHeight;

    nav.classList.toggle('scrolled', y > 20);
    if (progressBar && limit > 0) {
      progressBar.style.width = Math.min(100, (y / limit) * 100) + '%';
    }
  }

  // Native-scroll fallback (smooth:false still emits 'scroll', but be safe).
  window.addEventListener('scroll', function () {
    if (smooth) return;
    var limit = document.documentElement.scrollHeight - window.innerHeight;
    var y = window.scrollY;
    nav.classList.toggle('scrolled', y > 20);
    if (progressBar && limit > 0) progressBar.style.width = (y / limit) * 100 + '%';
  }, { passive: true });

  function onCall(value, way, obj) {
    if (value === 'reveal') {
      if (way === 'enter') obj.el.classList.add('is-revealed');
      return;
    }
    if (value.indexOf('step-') === 0) {
      if (way === 'enter') {
        document.querySelectorAll('.step').forEach(function (s) { s.classList.remove('is-active'); });
        obj.el.classList.add('is-active');
        setMockScene(Number(value.split('-')[1]));
      }
    }
  }

  /* ------------------------------------------------------ mock window -- */

  var SCENES = [
    {
      title: '# general',
      msgs: [
        { who: 'You', color: '#d9c9a3', text: 'right, server is up' },
        { who: 'Mina', color: '#d6c5cb', text: 'oh nice, what do we get?' },
        { who: 'You', color: '#d9c9a3', text: '#general, #random and a voice room' }
      ]
    },
    {
      title: '# general',
      msgs: [
        { who: 'You', color: '#d9c9a3', text: 'invite code is 4f8a21c9' },
        { who: 'Dan', color: '#c9d6c0', text: 'in 👋' },
        { who: 'Mina', color: '#d6c5cb', text: 'that was easy' }
      ]
    },
    {
      title: '◉ General',
      msgs: [
        { who: 'Dan', color: '#c9d6c0', text: 'joining voice' },
        { who: 'Mina', color: '#d6c5cb', text: 'can hear you fine' },
        { who: 'You', color: '#d9c9a3', text: 'peer to peer, no server hop 🎧' }
      ]
    }
  ];

  var mockChat = document.getElementById('mock-chat');
  var mockTitle = document.getElementById('mock-title');
  var sceneTimers = [];
  var currentScene = -1;

  function setMockScene(n) {
    var scene = SCENES[n - 1];
    if (!scene || !mockChat || currentScene === n) return;
    currentScene = n;

    sceneTimers.forEach(clearTimeout);
    sceneTimers = [];
    mockChat.innerHTML = '';
    mockTitle.textContent = scene.title;

    scene.msgs.forEach(function (m, i) {
      sceneTimers.push(setTimeout(function () {
        var row = document.createElement('div');
        row.className = 'mock-msg';
        row.innerHTML =
          '<div class="mock-av" style="background:' + m.color + '">' + m.who.charAt(0) + '</div>' +
          '<div><div class="mock-who">' + m.who + '</div>' +
          '<div class="mock-txt"></div></div>';
        mockChat.appendChild(row);
        typeInto(row.querySelector('.mock-txt'), m.text);
      }, i * 750));
    });
  }

  function typeInto(el, text) {
    if (!smooth) { el.textContent = text; return; }
    var i = 0;
    (function step() {
      el.textContent = text.slice(0, ++i);
      if (i < text.length) sceneTimers.push(setTimeout(step, 26));
    })();
  }

  /* --------------------------------------------------- motion toggle -- */

  function syncToggleLabel() {
    if (!motionToggle) return;
    motionToggle.textContent = smooth ? 'Disable smooth scrolling' : 'Enable smooth scrolling';
  }

  if (motionToggle) {
    motionToggle.addEventListener('click', function () {
      smooth = !smooth;
      try { localStorage.setItem(STORAGE_KEY, smooth ? '0' : '1'); } catch (e) {}
      if (scroll) scroll.destroy();          // avoid leaking the old instance
      init();
      syncToggleLabel();
      scroll.scrollTo('top', { duration: 0, disableLerp: true });
    });
  }

  /* ------------------------------------------------------------ boot -- */

  init();
  syncToggleLabel();
  setMockScene(1);

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (scroll) scroll.update(); }, 180);
  });

  window.addEventListener('beforeunload', function () { if (scroll) scroll.destroy(); });
})();
