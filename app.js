/* Mastermind — game UI, rules, offline pass-and-play and online challenge flow. */
(function () {
  'use strict';

  /* ================= helpers ================= */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clean(s, fb) { s = String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14); return s || fb || ''; }
  function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  var COLORS = 6, BLANK = 6, SYM = ['▲', '■', '✚', '◆', '★', '●'];
  var EMOJI = ['🤔', '🔥', '😅', '🎯'];

  var settings = Object.assign({ theme: 'vintage', sound: true, haptics: true, live: true, marks: false }, LS.get('mm.settings', {}));
  var prefs = Object.assign({ rounds: 4, rows: 10, dup: true, blank: false, first: 'me' }, LS.get('mm.prefs', {}));
  var names = Object.assign({ p1: '', p2: '', host: '', join: '' }, LS.get('mm.names', {}));
  function saveSettings() { LS.set('mm.settings', settings); }

  /* ================= audio + haptics ================= */
  var Sfx = (function () {
    var ctx = null, noise = null;
    function ac() {
      if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function nb(c) {
      if (noise) return noise;
      var b = c.createBuffer(1, c.sampleRate * 0.2, c.sampleRate), d = b.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return (noise = b);
    }
    function clack(c, t, f, vol, len) {
      var s = c.createBufferSource(); s.buffer = nb(c);
      var bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 1.3;
      var g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      s.connect(bp); bp.connect(g); g.connect(c.destination); s.start(t); s.stop(t + len + 0.02);
      var o = c.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(240, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.06);
      var g2 = c.createGain(); g2.gain.setValueAtTime(vol * 0.8, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      o.connect(g2); g2.connect(c.destination); o.start(t); o.stop(t + 0.1);
    }
    function tone(c, t, f0, f1, dur, type, vol) {
      var o = c.createOscillator(); o.type = type || 'sine';
      o.frequency.setValueAtTime(f0, t); if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      var g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
    }
    function run(fn) { if (!settings.sound) return; var c = ac(); if (c) { try { fn(c, c.currentTime + 0.005); } catch (e) {} } }
    return {
      unlock: function () { ac(); },
      place: function () { run(function (c, t) { clack(c, t, 2200, 0.45, 0.05); }); },
      pop: function () { run(function (c, t) { tone(c, t, 500, 900, 0.08, 'sine', 0.25); }); },
      key: function (fb) { run(function (c, t) { var n = Math.min(4, fb.exact + fb.colorOnly); for (var i = 0; i < n; i++) clack(c, t + 0.09 * i + 0.05, i < fb.exact ? 3400 : 4200, 0.18, 0.03); }); },
      shield: function () { run(function (c, t) { clack(c, t, 900, 0.7, 0.09); clack(c, t + 0.16, 700, 0.55, 0.1); }); },
      open: function () { run(function (c, t) { clack(c, t, 1200, 0.5, 0.08); tone(c, t, 300, 600, 0.2, 'triangle', 0.12); }); },
      incoming: function () { run(function (c, t) { tone(c, t, 660, 0, 0.09, 'sine', 0.22); tone(c, t + 0.1, 880, 0, 0.12, 'sine', 0.22); }); },
      win: function () { run(function (c, t) { [523, 659, 784, 1047].forEach(function (f, i) { tone(c, t + i * 0.11, f, 0, 0.3, 'triangle', 0.28); }); }); },
      lose: function () { run(function (c, t) { tone(c, t, 330, 220, 0.4, 'sawtooth', 0.12); tone(c, t + 0.25, 247, 165, 0.5, 'sawtooth', 0.12); }); }
    };
  })();
  function buzz(ms) { if (settings.haptics && navigator.vibrate) { try { navigator.vibrate(ms || 15); } catch (e) {} } }

  /* ================= ui plumbing ================= */
  var toastT = null;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }
  function show(name) {
    $$('.screen').forEach(function (s) { s.classList.toggle('active', s.id === 'screen-' + name); });
    $('#btn-home').hidden = name !== 'game';
    if (name === 'game') { fit(); updateNetDot(); } else $('#net-dot').hidden = true;
    curScreen = name;
  }
  var curScreen = 'home';

  var modalOpts = null;
  function openModal(html, handlers, opts) {
    var m = $('#modal'), sh = $('#sheet');
    modalOpts = opts || {};
    m.classList.toggle('cover-full', !!modalOpts.cover);
    sh.innerHTML = html; m.hidden = false;
    $$('[data-act]', sh).forEach(function (b) {
      b.onclick = function () { Sfx.unlock(); var h = handlers && handlers[b.dataset.act]; if (h) h(b); };
    });
  }
  function closeModal() { $('#modal').hidden = true; $('#sheet').innerHTML = ''; modalOpts = null; }
  $('#modal').addEventListener('click', function (e) { if (e.target.id === 'modal' && modalOpts && modalOpts.dismiss !== false) closeModal(); });

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (res, rej) {
      var ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? res() : rej(); } catch (e) { rej(e); } ta.remove();
    });
  }

  /* ---- option widgets (rounds / rows / rules) ---- */
  function optsHTML(withFirst) {
    function seg(key, vals) { return '<div class="seg" data-opt="' + key + '">' + vals.map(function (v) { return '<button type="button" data-v="' + v[0] + '">' + v[1] + '</button>'; }).join('') + '</div>'; }
    function sw(key) { return '<button type="button" class="switch" role="switch" data-opt="' + key + '" aria-checked="false"></button>'; }
    return '<div class="row-opt"><span>Rounds</span>' + seg('rounds', [[2, 2], [4, 4], [6, 6]]) + '</div>' +
      '<div class="row-opt"><span>Rows per round</span>' + seg('rows', [[10, 10], [12, 12]]) + '</div>' +
      '<div class="row-opt"><span>Allow duplicate colours</span>' + sw('dup') + '</div>' +
      '<div class="row-opt"><span>Allow blank spaces</span>' + sw('blank') + '</div>' +
      (withFirst ? '<div class="row-opt"><span>First codemaker</span>' + seg('first', [['me', 'Me'], ['opp', 'Opponent'], ['rand', 'Random']]) + '</div>' : '');
  }
  function applyOpts(root) {
    $$('[data-opt]', root).forEach(function (el) {
      var k = el.dataset.opt, v = prefs[k];
      if (el.classList.contains('seg')) $$('button', el).forEach(function (b) { b.classList.toggle('on', String(b.dataset.v) === String(v)); });
      else el.setAttribute('aria-checked', v ? 'true' : 'false');
    });
  }
  function readOpts(root) {
    var o = {};
    $$('[data-opt]', root).forEach(function (el) {
      var k = el.dataset.opt;
      if (el.classList.contains('seg')) { var b = $('button.on', el); var v = b && b.dataset.v; o[k] = (k === 'first') ? v : Number(v); }
      else o[k] = el.getAttribute('aria-checked') === 'true';
    });
    Object.assign(prefs, o); LS.set('mm.prefs', prefs);
    return o;
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('.seg button'); if (b) { $$('button', b.parentNode).forEach(function (x) { x.classList.toggle('on', x === b); }); return; }
    var s = e.target.closest('.switch[data-opt]'); if (s) s.setAttribute('aria-checked', s.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
  });

  /* ================= rules ================= */
  function evaluate(secret, guess) {
    var exact = 0, sc = {}, gc = {}, i, k;
    for (i = 0; i < 4; i++) {
      if (secret[i] === guess[i]) exact++;
      else { sc[secret[i]] = (sc[secret[i]] || 0) + 1; gc[guess[i]] = (gc[guess[i]] || 0) + 1; }
    }
    var colorOnly = 0;
    for (k in gc) colorOnly += Math.min(gc[k], sc[k] || 0);
    return { exact: exact, colorOnly: colorOnly };
  }
  function keyOrder(fb) {
    var a = []; for (var i = 0; i < fb.exact; i++) a.push(2); for (i = 0; i < fb.colorOnly; i++) a.push(1);
    while (a.length < 4) a.push(0);
    return shuffle(a);
  }
  function maxColor(cfg) { return cfg.blank ? BLANK : COLORS - 1; }
  function validGuess(g, cfg) {
    return Array.isArray(g) && g.length === 4 && g.every(function (v) { return Number.isInteger(v) && v >= 0 && v <= maxColor(cfg); });
  }
  function validCode(c, cfg) {
    if (!validGuess(c, cfg)) return false;
    return cfg.dup || c.every(function (v, i) { return c.indexOf(v) === i; });
  }
  function validFb(m) { return Number.isInteger(m.exact) && Number.isInteger(m.colorOnly) && m.exact >= 0 && m.colorOnly >= 0 && m.exact + m.colorOnly <= 4; }
  function sanitizeCfg(c) {
    c = c || {};
    return { rounds: [2, 4, 6].indexOf(c.rounds) >= 0 ? c.rounds : 4, rows: [10, 12].indexOf(c.rows) >= 0 ? c.rows : 10, dup: !!c.dup, blank: !!c.blank };
  }

  /* ================= game model ================= */
  var G = null, S = null;
  var entry = { slots: [null, null, null, null], sel: null };
  var ui = { pop: null, fbRow: -1, hold: null, preview: null, pending: {}, rematch: { me: false, opp: false }, lastNet: 'idle', locking: false };

  function cur() { return G.rounds[G.roundIdx]; }
  function pending(R) { return R.guesses.length > 0 && !R.guesses[R.guesses.length - 1].fb; }
  function roleOf(R) {
    if (G.mode === 'online') return R.maker === G.me ? 'maker' : 'breaker';
    return R.state === 'setcode' ? 'maker' : 'breaker';
  }
  function resetEntry() { entry.slots = [null, null, null, null]; entry.sel = null; }
  function saveLocal() { if (G && G.mode === 'local') LS.set('mm.match', G); }

  function createMatch(o) {
    G = { mode: o.mode, names: o.names, cfg: o.cfg, first: o.first, me: o.me == null ? null : o.me, scores: [0, 0], roundIdx: -1, rounds: [], over: false, counted: false };
    ui.pending = {}; ui.preview = null; ui.rematch = { me: false, opp: false };
  }
  function newRound() {
    G.roundIdx++;
    var n = G.roundIdx, maker = (G.first + n) % 2;
    var R = { n: n, maker: maker, secret: null, salt: null, commit: null, guesses: [], state: 'setcode', cracked: false, pts: 0, reveal: null, verify: null, done: false };
    if (G.mode === 'online' && maker !== G.me) R.state = 'waitcode';
    G.rounds.push(R);
    resetEntry(); ui.locking = false; ui.fbRow = -1; ui.preview = null;
    buildBoard(); renderAll();
    if (G.mode === 'online' && ui.pending[n]) { var p = ui.pending[n]; delete ui.pending[n]; applyRoundStart(R, p); }
  }

  /* ================= board build / render ================= */
  function pegHTML(v, pop) {
    return '<span class="peg ' + (v === BLANK ? 'blank' : 'c' + v) + (pop ? ' pop' : '') + '" data-m="' + (SYM[v] || '') + '"></span>';
  }
  function buildBoard() {
    var rows = G.cfg.rows;
    $('#board').innerHTML =
      '<div class="track"><div class="tcol"><i class="spk sp0" id="spk0"></i></div><div class="tcol"><i class="spk sp1" id="spk1"></i></div></div>' +
      '<div class="field-col"><div class="rows" id="rows"></div>' +
      '<div class="shield closed" id="shield"><div class="secret" id="secret"></div><div class="cover"><span>MASTERMIND</span></div></div></div>' +
      '<div class="lid"><span class="lid-text">MASTERMIND</span></div>';
    var bd = $('#board'); bd.style.setProperty('--hu', rows * 2.5 + 5.4);
    // pegs tray
    var n = G.cfg.blank ? 7 : 6, h = '';
    for (var v = 0; v < n; v++) h += '<button class="dpeg" data-v="' + v + '" aria-label="' + (v === BLANK ? 'Blank' : 'Colour ' + (v + 1)) + '">' + pegHTML(v) + '</button>';
    $('#pegtray').innerHTML = h;
    fit();
  }
  function fit() {
    if (!G) return;
    var w = $('#board-wrap'), bd = $('#board'), hu = G.cfg.rows * 2.5 + 5.4;
    var W = w.clientWidth - 12, H = w.clientHeight - 6;
    if (W <= 0 || H <= 0) return;
    bd.style.setProperty('--u', Math.max(8, Math.min(W / 18, H / hu)) + 'px');
  }
  if (window.ResizeObserver) new ResizeObserver(fit).observe($('#board-wrap'));
  window.addEventListener('resize', fit);

  function entryActive() {
    if (!G || G.over || ui.hold) return null;
    var R = cur(); if (!R) return null; var role = roleOf(R);
    if (R.state === 'setcode' && role === 'maker' && !ui.locking) return 'secret';
    if (R.state === 'guessing' && role === 'breaker' && !R.done && !pending(R) && R.guesses.length < G.cfg.rows) return 'row';
    return null;
  }

  function renderRows() {
    var R = cur(), rows = G.cfg.rows, role = roleOf(R), k = entryActive(), h = '';
    var activeIdx = k === 'row' ? R.guesses.length : -1;
    var watching = (G.mode === 'online' && role === 'maker' && R.state === 'guessing' && !R.done && !pending(R) && R.guesses.length < rows) ? R.guesses.length : -1;
    for (var r = 0; r < rows; r++) {
      var g = R.guesses[r], slots, cls = 'row';
      if (g) { slots = g.guess; }
      else if (r === activeIdx) { slots = entry.slots; cls += ' active'; }
      else if (r === watching) {
        slots = (settings.live && ui.preview && ui.preview.n === R.n && ui.preview.row === r) ? ui.preview.slots : [null, null, null, null]; cls += ' watching';
      } else slots = [null, null, null, null];
      var hh = '';
      for (var s = 0; s < 4; s++) {
        var v = slots[s], pop = ui.pop && ui.pop.k === 'row' && ui.pop.i === s && r === activeIdx;
        hh += '<div class="hole' + (r === activeIdx && entry.sel === s ? ' sel' : '') + '" data-r="' + r + '" data-s="' + s + '">' + (v != null ? pegHTML(v, pop) : '') + '</div>';
      }
      var kh = '';
      for (var q = 0; q < 4; q++) {
        var o = g && g.fb ? g.order[q] : 0, dr = ui.fbRow === r ? ' drop" style="--kd:' + (q * 0.07) + 's' : '';
        kh += '<i class="kh">' + (o ? '<b class="kp k' + o + dr + '"></b>' : '') + '</i>';
      }
      h += '<div class="' + cls + '"><span class="rno">' + (r + 1) + '</span><div class="holes">' + hh + '</div><div class="keys">' + kh + '</div></div>';
    }
    $('#rows').innerHTML = h;
    ui.fbRow = -1;
  }

  function renderShield() {
    var R = cur(), role = roleOf(R), cls, secret = null;
    if (R.state === 'setcode' && role === 'maker') { cls = 'open'; secret = entry.slots; }
    else if (R.done) { cls = 'open'; secret = R.reveal; }
    else { cls = 'closed'; if (G.mode === 'online' && role === 'maker' && R.secret) { cls += ' peek'; secret = R.secret; } }
    if (ui.hold) secret = ui.hold;
    var h = '';
    for (var i = 0; i < 4; i++) {
      var v = secret ? secret[i] : null, pop = ui.pop && ui.pop.k === 'secret' && ui.pop.i === i;
      h += '<div class="hole' + (cls === 'open' && !R.done && entry.sel === i ? ' sel' : '') + '" data-secret="' + i + '">' + (v != null ? pegHTML(v, pop) : '') + '</div>';
    }
    $('#secret').innerHTML = h;
    var sh = $('#shield'), prevOpen = sh.classList.contains('open');
    sh.className = 'shield ' + cls;
    if (R.done && !prevOpen && !ui.hold) Sfx.open();
  }

  function renderTrack() {
    var rows = G.cfg.rows, N = rows * 2, maxS = (G.cfg.rounds / 2) * (rows + 1);
    [0, 1].forEach(function (p) {
      var idx = Math.min(N - 1, Math.round(G.scores[p] / maxS * (N - 1)));
      $('#spk' + p).style.setProperty('--i', idx);
    });
  }

  function renderScorebar() {
    var R = cur();
    [0, 1].forEach(function (p) {
      var el = $('#pl' + p); $('.nm', el).textContent = G.names[p]; $('.sc', el).textContent = G.scores[p];
      el.classList.toggle('maker', R.maker === p);
    });
    $('#round-label').textContent = 'Round ' + (G.roundIdx + 1) + ' / ' + G.cfg.rounds;
    var role = roleOf(R);
    $('#role-label').textContent = G.mode === 'online'
      ? (role === 'maker' ? 'You are the Codemaker' : 'You are the Codebreaker')
      : (R.state === 'setcode' ? G.names[R.maker] + ' is making' : G.names[1 - R.maker] + ' is breaking');
  }

  function actionState() {
    var R = cur(), role = roleOf(R), k = entryActive(), full = entry.slots.indexOf(null) < 0;
    if (R.done || G.over) return { hidden: true };
    if (k === 'secret') return { label: 'Lock Code & Hide', enabled: full };
    if (k === 'row') return { label: 'Check Row', enabled: full };
    if (G.mode === 'online') {
      if (role === 'maker') return { label: ui.locking ? 'Locking…' : 'Opponent is guessing…', enabled: false };
      if (R.state === 'waitcode') return { label: 'Waiting for code…', enabled: false };
      if (pending(R)) return { label: 'Checking…', enabled: false };
    }
    return { label: ui.hold ? 'Code locked' : '…', enabled: false };
  }
  function renderDock() {
    var k = entryActive(), a = actionState();
    $$('.dpeg').forEach(function (b) { b.disabled = !k; });
    var ab = $('#btn-action'); ab.hidden = !!a.hidden; ab.textContent = a.label || ''; ab.disabled = !a.enabled;
    $('#btn-undo').disabled = !k || entry.slots.every(function (v) { return v == null; });
    $('#btn-react').hidden = G.mode !== 'online';
    if (G.mode !== 'online') $('#reactbar').hidden = true;
  }
  function renderStatus() {
    var R = cur(), role = roleOf(R), st = $('#status'), msg = '', warn = false, rows = G.cfg.rows;
    if (G.mode === 'online' && S && ['reconnecting', 'offline'].indexOf(S.status) >= 0) {
      msg = S.status === 'offline' ? 'Offline — waiting for network…' : 'Connection lost — reconnecting…'; warn = true;
    } else if (R.done) msg = R.cracked ? 'Code cracked!' : 'The code held!';
    else if (G.mode === 'local') {
      msg = R.state === 'setcode'
        ? G.names[R.maker] + ': tap 4 pegs to set the secret code'
        : G.names[1 - R.maker] + ': guess ' + (R.guesses.length + 1) + ' of ' + rows;
    } else if (role === 'maker') {
      msg = R.state === 'setcode' ? 'Set your secret code — it stays on this device until the round ends'
        : 'Guess ' + Math.min(rows, R.guesses.length + (pending(R) ? 0 : 1)) + ' of ' + rows + ' — ' + G.names[1 - G.me] + ' is thinking…';
    } else {
      msg = R.state === 'waitcode' ? 'Waiting for ' + G.names[R.maker] + ' to set the code…'
        : pending(R) ? 'Checking your guess…' : 'Your guess — row ' + (R.guesses.length + 1) + ' of ' + rows;
    }
    st.textContent = msg; st.classList.toggle('warn', warn);
  }
  function renderAll() {
    if (!G || !G.rounds.length) return;
    renderScorebar(); renderRows(); renderShield(); renderTrack(); renderDock(); renderStatus();
    ui.pop = null;
  }
  function afterEntryChange() {
    renderRows(); renderShield(); renderDock(); ui.pop = null; sendPreview();
  }

  /* ---- input ---- */
  function entryPlace(v) {
    var k = entryActive(); if (!k) return;
    var i = (entry.sel != null && entry.slots[entry.sel] == null) ? entry.sel : entry.slots.indexOf(null);
    if (i < 0) return;
    if (k === 'secret' && !G.cfg.dup && entry.slots.indexOf(v) >= 0) {
      toast('No duplicate colours allowed in the code'); buzz(30);
      var h = $('#secret .hole[data-secret="' + i + '"]'); if (h) { h.classList.add('shake'); }
      return;
    }
    entry.slots[i] = v; entry.sel = null; ui.pop = { k: k, i: i };
    Sfx.place(); buzz(15); afterEntryChange();
  }
  function entryTapSlot(i) {
    var k = entryActive(); if (!k) return;
    if (entry.slots[i] != null) { entry.slots[i] = null; entry.sel = i; Sfx.pop(); buzz(10); }
    else entry.sel = entry.sel === i ? null : i;
    afterEntryChange();
  }
  function entryUndo() {
    if (!entryActive()) return;
    for (var i = 3; i >= 0; i--) if (entry.slots[i] != null) { entry.slots[i] = null; entry.sel = null; Sfx.pop(); buzz(10); break; }
    afterEntryChange();
  }
  $('#board').addEventListener('click', function (e) {
    var h = e.target.closest('.hole'); if (!h) return;
    Sfx.unlock();
    var k = entryActive(); if (!k) return;
    if (k === 'secret' && h.dataset.secret != null) entryTapSlot(+h.dataset.secret);
    else if (k === 'row' && h.dataset.r != null && +h.dataset.r === cur().guesses.length) entryTapSlot(+h.dataset.s);
  });
  $('#pegtray').addEventListener('click', function (e) { var b = e.target.closest('.dpeg'); if (b && !b.disabled) { Sfx.unlock(); entryPlace(+b.dataset.v); } });
  $('#btn-undo').addEventListener('click', entryUndo);
  $('#btn-action').addEventListener('click', function () {
    Sfx.unlock();
    var k = entryActive(); if (k === 'secret') lockCode(); else if (k === 'row') checkRow();
  });

  /* ================= round flow (shared) ================= */
  function pushGuess(R, guess, fb) {
    R.guesses.push({ guess: guess, fb: fb, order: keyOrder(fb) });
    ui.fbRow = R.guesses.length - 1;
  }

  function lockCode() {
    var R = cur();
    if (ui.locking || entry.slots.indexOf(null) >= 0) return;
    ui.locking = true;
    R.secret = entry.slots.slice();
    var online = G.mode === 'online';
    var prep = online ? MMNet.makeCommit(R.secret).then(function (c) { R.salt = c.salt; R.commit = c.commit; }) : Promise.resolve();
    prep.then(function () {
      ui.hold = R.secret.slice(); R.state = 'guessing'; resetEntry(); ui.locking = false;
      Sfx.shield(); buzz(25); renderAll();
      if (online) netSend({ t: 'ROUND_START', n: R.n, commit: R.commit });
      else saveLocal();
      setTimeout(function () {
        ui.hold = null; renderShield();
        if (!online) showPass('breaker');
      }, 800);
    });
  }

  function checkRow() {
    var R = cur(); if (entry.slots.indexOf(null) >= 0) return;
    var guess = entry.slots.slice(); resetEntry();
    if (G.mode === 'local') {
      var fb = evaluate(R.secret, guess); pushGuess(R, guess, fb);
      Sfx.key(fb); buzz(20);
      if (fb.exact === 4 || R.guesses.length >= G.cfg.rows) endRound(R); else { saveLocal(); renderAll(); }
    } else {
      R.guesses.push({ guess: guess, fb: null, order: null });
      netSend({ t: 'GUESS', n: R.n, row: R.guesses.length - 1, guess: guess });
      Sfx.place(); renderAll();
    }
  }

  function endRound(R) {
    if (R.done) return;
    R.done = true; R.state = 'done';
    var last = R.guesses[R.guesses.length - 1];
    R.cracked = !!(last && last.fb && last.fb.exact === 4);
    R.pts = R.guesses.length + (R.cracked ? 0 : 1);
    G.scores[R.maker] += R.pts;
    if (G.mode === 'local') R.reveal = R.secret; else if (R.maker === G.me) R.reveal = R.secret;
    saveLocal();
    if (R !== cur()) return;
    renderAll();
    var iBroke = G.mode === 'online' ? R.maker !== G.me : true;
    var good = G.mode === 'local' ? true : (iBroke ? R.cracked : !R.cracked);
    setTimeout(function () { if (good) Sfx.win(); else Sfx.lose(); }, 500);
    setTimeout(function () { if (G && cur() === R && R.done) showRoundEnd(R); }, 1300);
  }

  function revealRow(code) {
    return '<div class="reveal-row">' + code.map(function (v) { return '<div class="dpeg">' + pegHTML(v) + '</div>'; }).join('') + '</div>';
  }
  function scoreLine() {
    return '<div class="score-line"><div>' + esc(G.names[0]) + '<b>' + G.scores[0] + '</b></div><div>' + esc(G.names[1]) + '<b>' + G.scores[1] + '</b></div></div>';
  }
  function showRoundEnd(R) {
    var maker = G.names[R.maker], breaker = G.names[1 - R.maker], last = G.roundIdx + 1 >= G.cfg.rounds;
    var title = R.cracked ? '🎉 ' + esc(breaker) + ' cracked it in ' + R.guesses.length + '!' : '🔒 ' + esc(maker) + '’s code held!';
    var ver = '';
    if (R.verify) ver = R.verify.ok ? '<div class="verify">✓ Code verified against the opening commitment</div>'
      : '<div class="verify bad">⚠ Verification failed: ' + esc(R.verify.why) + '</div>';
    openModal('<h3>' + title + '</h3>' + revealRow(R.reveal || []) +
      '<p>' + esc(maker) + ' scores <b>+' + R.pts + '</b> (' + R.guesses.length + ' row' + (R.guesses.length === 1 ? '' : 's') + (R.cracked ? '' : ' + 1 bonus') + ')</p>' + ver + scoreLine() +
      '<div class="btnrow"><button class="btn primary" data-act="next">' + (last ? 'See final result' : 'Next Round (Swap Roles)') + '</button></div>',
      { next: nextRound }, { dismiss: false });
  }

  function nextRound() {
    closeModal();
    if (G.roundIdx + 1 >= G.cfg.rounds) return showMatchEnd();
    newRound();
    if (G.mode === 'local') { saveLocal(); showPass('maker'); }
  }

  /* ---- local pass-and-play ---- */
  function showPass(who) {
    var R = cur(), idx = who === 'maker' ? R.maker : 1 - R.maker, nm = G.names[idx];
    ui.locking = false; resetEntry(); renderAll();
    openModal('<div class="big-emoji">📱</div><h3>Pass device to ' + esc(nm) + '</h3>' +
      (who === 'maker'
        ? '<p>You are the <b>Codemaker</b>. Set the secret code — everyone else, look away!</p>'
        : '<p>You are the <b>Codebreaker</b>. Crack the code in ' + G.cfg.rows + ' rows or fewer.</p>') +
      '<div class="btnrow"><button class="btn primary" data-act="go">I’m ' + esc(nm) + ' — ready</button></div>',
      { go: function () { closeModal(); Sfx.pop(); renderAll(); } }, { cover: true, dismiss: false });
  }

  function startLocal() {
    var p1 = clean($('#local-p1').value, 'Player 1'), p2 = clean($('#local-p2').value, 'Player 2');
    if (p1.toLowerCase() === p2.toLowerCase()) p2 = p2 + ' 2';
    names.p1 = $('#local-p1').value; names.p2 = $('#local-p2').value; LS.set('mm.names', names);
    var o = readOpts($('#local-opts'));
    createMatch({ mode: 'local', names: [p1, p2], cfg: sanitizeCfg(o), first: 0 });
    show('game'); newRound(); saveLocal(); showPass('maker');
  }
  function resumeLocal() {
    var saved = LS.get('mm.match', null);
    if (!saved || !saved.rounds || !saved.rounds.length) return;
    G = saved; S = null; ui.pending = {}; ui.locking = false; resetEntry();
    show('game'); buildBoard(); renderAll();
    var R = cur();
    if (R.done) showRoundEnd(R); else if (R.state === 'setcode') showPass('maker'); else showPass('breaker');
  }

  /* ---- match end / stats ---- */
  function recordStats() {
    if (G.counted) return; G.counted = true;
    var st = Object.assign({ matches: 0, online: 0, players: {} }, LS.get('mm.stats', {}));
    st.matches++; if (G.mode === 'online') st.online++;
    var idxs = G.mode === 'online' ? [G.me] : [0, 1];
    idxs.forEach(function (i) {
      var nm = G.names[i], p = st.players[nm] || { m: 0, w: 0, l: 0, d: 0, best: null };
      p.m++; var mine = G.scores[i], theirs = G.scores[1 - i];
      if (mine > theirs) p.w++; else if (mine < theirs) p.l++; else p.d++;
      G.rounds.forEach(function (R) { if (R.cracked && R.maker !== i && (p.best == null || R.guesses.length < p.best)) p.best = R.guesses.length; });
      st.players[nm] = p;
    });
    LS.set('mm.stats', st);
  }
  function showMatchEnd() {
    G.over = true; recordStats();
    var a = G.scores[0], b = G.scores[1], online = G.mode === 'online';
    var title, emoji = '🏆';
    if (a === b) { title = 'It’s a draw!'; emoji = '🤝'; }
    else {
      var w = a > b ? 0 : 1; title = esc(G.names[w]) + ' wins!';
      if (online) emoji = w === G.me ? '🏆' : '😎';
    }
    if (G.mode === 'local') LS.del('mm.match');
    Sfx.win(); buzz([30, 40, 30]);
    openModal('<div class="big-emoji">' + emoji + '</div><h3 style="text-align:center">' + title + '</h3>' + scoreLine() +
      '<div class="btnrow"><button class="btn primary" data-act="again">' + (online ? 'Rematch' : 'Play again') + '</button><button class="btn ghost" data-act="home">' + (online ? 'Leave' : 'Home') + '</button></div>' +
      '<p id="rematch-note" class="center muted"></p>',
      { again: rematch, home: goHome }, { dismiss: false });
    renderAll();
  }
  function rematch() {
    if (G.mode === 'local') {
      var cfg = G.cfg, nm = G.names, first = 1 - G.first;
      createMatch({ mode: 'local', names: nm, cfg: cfg, first: first }); closeModal();
      newRound(); saveLocal(); showPass('maker');
    } else {
      ui.rematch.me = true; netSend({ t: 'REMATCH' });
      var n = $('#rematch-note'); if (n) n.textContent = 'Rematch requested — waiting for ' + G.names[1 - G.me] + '…';
      var b = $('[data-act="again"]'); if (b) b.disabled = true;
      maybeStartRematch();
    }
  }
  function maybeStartRematch() {
    if (!(G && G.mode === 'online' && G.me === 0 && ui.rematch.me && ui.rematch.opp)) return;
    var first = 1 - G.first;
    var msg = { t: 'WELCOME', names: G.names, cfg: G.cfg, first: first };
    createMatch({ mode: 'online', names: G.names, cfg: G.cfg, first: first, me: 0 });
    netSend(msg); closeModal(); newRound();
  }

  function showStats() {
    var st = Object.assign({ matches: 0, online: 0, players: {} }, LS.get('mm.stats', {}));
    var rows = Object.keys(st.players).map(function (n) { var p = st.players[n]; return { n: n, p: p }; }).sort(function (a, b) { return b.p.w - a.p.w; }).slice(0, 8);
    openModal('<h3>Stats</h3><div class="stat-grid"><div><b>' + st.matches + '</b>Matches</div><div><b>' + (st.matches - st.online) + '</b>Pass &amp; play</div><div><b>' + st.online + '</b>Online</div></div>' +
      (rows.length ? '<table class="t"><tr><th>Player</th><th>W</th><th>L</th><th>D</th><th>Best crack</th></tr>' + rows.map(function (r) {
        return '<tr><td>' + esc(r.n) + '</td><td>' + r.p.w + '</td><td>' + r.p.l + '</td><td>' + r.p.d + '</td><td>' + (r.p.best == null ? '—' : r.p.best + ' rows') + '</td></tr>';
      }).join('') + '</table>' : '<p>No matches finished yet.</p>') +
      '<div class="btnrow"><button class="btn ghost" data-act="close">Close</button><button class="btn ghost" data-act="reset">Reset stats</button></div>',
      { close: closeModal, reset: function () { LS.del('mm.stats'); showStats(); } });
  }
  function showHelp() {
    openModal('<h3>How to play</h3><ol><li>The <b>Codemaker</b> hides a secret code of 4 coloured pegs behind the shield.</li>' +
      '<li>The <b>Codebreaker</b> fills a row with a guess and taps <b>Check Row</b>.</li>' +
      '<li>Each <b>red</b> key peg = right colour, right place. Each <b>white</b> key peg = right colour, wrong place. Key peg positions are shuffled.</li>' +
      '<li>Crack the code before you run out of rows, then swap roles.</li></ol>' +
      '<p><b>Scoring:</b> the Codemaker earns 1 point for every row the Codebreaker used, plus 1 bonus point if the code is never cracked. Highest score after all rounds wins.</p>' +
      '<p><b>Tips:</b> tap a peg in the tray to drop it into the next hole, or tap a hole first to choose where it goes. Tap a placed peg to remove it.</p>' +
      '<p><b>Online fairness:</b> the secret never leaves the codemaker’s device until the round ends. A SHA-256 commitment sent at the start lets the codebreaker verify the code wasn’t changed, and that every key peg was honest.</p>' +
      '<div class="btnrow"><button class="btn primary" data-act="close">Got it</button></div>', { close: closeModal });
  }
  var deferredInstall = null;
  function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; }
  function showInstall() {
    var ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var ios_ = '<b>iPhone / iPad (Safari)</b><ol><li>Tap the <b>Share</b> button (square with arrow).</li><li>Scroll and tap <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>. Launch Mastermind from your home screen.</li></ol>';
    var and_ = '<b>Android (Chrome)</b><ol><li>Tap the <b>⋮</b> menu.</li><li>Tap <b>Install app</b> (or <b>Add to Home screen</b>).</li><li>Confirm. It now works offline, full-screen.</li></ol>';
    openModal('<h3>Install Offline App</h3><p>Mastermind caches itself so Pass &amp; Play works in airplane mode.</p>' +
      (ios ? ios_ + and_ : and_ + ios_) +
      '<div class="btnrow">' + (deferredInstall ? '<button class="btn primary" data-act="install">Install now</button>' : '') + '<button class="btn ghost" data-act="close">Close</button></div>',
      { close: closeModal, install: function () { deferredInstall.prompt(); deferredInstall = null; closeModal(); } });
  }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredInstall = e; });
  function showMenu() {
    function item(key, label, on) { return '<button class="menu-item" data-act="' + key + '"><span>' + label + '</span>' + (on == null ? '<span>›</span>' : '<span class="switch" aria-checked="' + on + '"></span>') + '</button>'; }
    openModal('<h3>Menu</h3><div class="menu-list">' +
      item('live', 'Show opponent placing pegs live', settings.live) + item('haptics', 'Haptic feedback', settings.haptics) + item('marks', 'Colour-blind symbols on pegs', settings.marks) +
      item('stats', 'Stats') + item('help', 'How to play') + item('install', 'Install offline app') + '</div>' +
      '<div class="btnrow"><button class="btn ghost" data-act="close">Close</button></div>', {
        close: closeModal,
        live: function () { settings.live = !settings.live; saveSettings(); showMenu(); if (G) renderAll(); },
        haptics: function () { settings.haptics = !settings.haptics; saveSettings(); showMenu(); buzz(20); },
        marks: function () { settings.marks = !settings.marks; saveSettings(); applySettings(); showMenu(); },
        stats: showStats, help: showHelp, install: showInstall
      });
  }

  /* ================= online ================= */
  function netSend(o) { return S ? S.send(o) : false; }
  function sendPreview() {
    if (G && G.mode === 'online' && entryActive() === 'row') netSend({ t: 'PREVIEW', n: cur().n, row: cur().guesses.length, slots: entry.slots.slice() });
  }
  function netErr(e) {
    var t = e && e.type;
    if (t === 'peer-unavailable') return 'No challenge found with that code.';
    if (t === 'busy') return 'That challenge already has a challenger.';
    if (t === 'timeout') return 'Could not reach the matchmaking relay. Check your connection.';
    if (t === 'no-peerjs') return 'Online module failed to load.';
    if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') return 'Network problem reaching the relay. Try again.';
    return 'Could not connect' + (t ? ' (' + t + ')' : '') + '.';
  }
  function updateNetDot() {
    var d = $('#net-dot');
    if (!G || G.mode !== 'online' || !S) { d.hidden = true; return; }
    var s = S.status; d.hidden = false;
    d.className = 'net-dot ' + (s === 'connected' ? 'ok' : s === 'reconnecting' ? 'wait' : 'bad');
    d.title = s === 'connected' ? 'Connected' : s === 'reconnecting' ? 'Reconnecting' : 'Offline';
  }
  function updateOnlineAvail() {
    var off = !navigator.onLine;
    $('#online-badge').hidden = !off; $('#btn-online').disabled = off;
  }
  window.addEventListener('online', updateOnlineAvail); window.addEventListener('offline', updateOnlineAvail);

  function wire(s) {
    s.on('status', function () { updateNetDot(); if (G && G.mode === 'online' && curScreen === 'game') renderStatus(); });
    s.on('msg', onNetMsg);
    s.on('reconnected', function () { toast('Reconnected'); sendSync(); });
    s.on('closed', function (info) {
      if (!G || G.mode !== 'online') return;
      var why = info && info.reason === 'left' ? 'Your opponent left the challenge.' : 'The connection was lost and could not be restored.';
      openModal('<div class="big-emoji">📡</div><h3 class="center">Challenge ended</h3><p class="center">' + why + '</p><div class="btnrow"><button class="btn primary" data-act="home">Back to home</button></div>', { home: goHome }, { dismiss: false });
    });
  }

  function hostCreate() {
    if (!navigator.onLine) return toast('Online mode requires an internet connection');
    var name = clean($('#host-name').value, 'Host'); names.host = $('#host-name').value; LS.set('mm.names', names);
    var o = readOpts($('#host-opts')); var cfg = sanitizeCfg(o);
    $('#host-go').disabled = true;
    S = new MMNet.Session(); wire(S);
    S.on('open', function (info) {
      var first = o.first === 'me' ? 0 : o.first === 'opp' ? 1 : Math.round(Math.random());
      var nm = [name, clean(info.name, 'Guest')];
      if (nm[1].toLowerCase() === nm[0].toLowerCase()) nm[1] += ' 2';
      createMatch({ mode: 'online', names: nm, cfg: cfg, first: first, me: 0 });
      netSend({ t: 'WELCOME', names: nm, cfg: cfg, first: first });
      show('game'); newRound(); Sfx.incoming();
    });
    S.host(name).then(function (code) {
      $('#host-setup').hidden = true; $('#host-lobby').hidden = false;
      $('#code-text').textContent = MMNet.formatCode(code);
      $('#host-status').textContent = 'Waiting for challenger...'; $('#host-dot').className = 'net-dot wait';
    }, function (e) {
      toast(netErr(e)); $('#host-go').disabled = false; try { S.close(); } catch (x) {} S = null;
    });
  }
  function shareChallenge() {
    if (!S || !S.code) return;
    var url = location.origin + location.pathname + '?join=' + S.code;
    var text = 'Join my Mastermind challenge! Code: ' + MMNet.formatCode(S.code);
    if (navigator.share) {
      navigator.share({ title: 'Mastermind Challenge', text: text, url: url }).catch(function (e) {
        if (e && e.name === 'AbortError') return;
        copyText(text + ' ' + url).then(function () { toast('Challenge link copied'); });
      });
    } else copyText(text + ' ' + url).then(function () { toast('Challenge link copied'); }, function () { toast('Code: ' + MMNet.formatCode(S.code)); });
  }
  function joinGo() {
    if (!navigator.onLine) return toast('Online mode requires an internet connection');
    var code = MMNet.normalizeCode($('#join-code').value);
    if (code.length !== MMNet.CODE_LEN) return toast('Enter the 6-character challenge code');
    var name = clean($('#join-name').value, 'Guest'); names.join = $('#join-name').value; LS.set('mm.names', names);
    var st = $('#join-status'), dot = $('#join-dot');
    $('#join-go').disabled = true; st.textContent = 'Connecting…'; dot.hidden = false; dot.className = 'net-dot wait';
    S = new MMNet.Session(); wire(S);
    S.join(code, name).then(function () {
      st.textContent = 'Connected! Waiting for host to start…'; dot.className = 'net-dot ok';
    }, function (e) {
      st.textContent = netErr(e); dot.className = 'net-dot bad'; $('#join-go').disabled = false; try { S.close(); } catch (x) {} S = null;
    });
  }

  function onNetMsg(m) {
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'WELCOME') {
      if (!Array.isArray(m.names) || m.names.length !== 2) return;
      var nm = [clean(m.names[0], 'Host'), clean(m.names[1], 'Guest')];
      if (G && G.mode === 'online' && !G.over) return; // duplicate welcome (resync)
      createMatch({ mode: 'online', names: nm, cfg: sanitizeCfg(m.cfg), first: m.first === 1 ? 1 : 0, me: 1 });
      closeModal(); show('game'); newRound(); Sfx.incoming(); return;
    }
    if (!G || G.mode !== 'online') return;
    switch (m.t) {
      case 'ROUND_START': return onRoundStart(m);
      case 'GUESS': return onGuess(m);
      case 'FEEDBACK': return onFeedback(m);
      case 'REVEAL': return onReveal(m);
      case 'PREVIEW':
        if (Number.isInteger(m.n) && Number.isInteger(m.row) && Array.isArray(m.slots) && m.slots.length === 4 && m.slots.every(function (v) { return v === null || (Number.isInteger(v) && v >= 0 && v <= BLANK); })) {
          ui.preview = { n: m.n, row: m.row, slots: m.slots };
          var R = cur(); if (R && R.n === m.n && R.state === 'guessing') renderRows();
        } return;
      case 'REACT': if (EMOJI.indexOf(m.emoji) >= 0) floatEmoji(m.emoji, G.names[1 - G.me]); return;
      case 'SYNC': return onSync(m);
      case 'REMATCH': ui.rematch.opp = true; var n = $('#rematch-note'); if (n && !ui.rematch.me) n.textContent = G.names[1 - G.me] + ' wants a rematch!'; maybeStartRematch(); return;
    }
  }

  // Codebreaker: the codemaker has locked a code and sent only its SHA-256 commitment.
  function onRoundStart(m) {
    if (!Number.isInteger(m.n) || typeof m.commit !== 'string' || !/^[0-9a-f]{64}$/.test(m.commit)) return;
    var R = G.rounds[m.n];
    if (!R) { ui.pending[m.n] = m; return; }
    if (R.maker === G.me) return;
    applyRoundStart(R, m);
  }
  function applyRoundStart(R, m) {
    if (R.state !== 'waitcode') return;
    R.commit = m.commit; R.state = 'guessing';
    if (R === cur()) { Sfx.incoming(); buzz(20); renderAll(); }
  }
  // Codemaker: evaluate the guess locally; only { exact, colorOnly } leaves this device.
  function onGuess(m) {
    var R = G.rounds[m.n];
    if (!R || R.maker !== G.me || R.state !== 'guessing' || !R.secret || R.done) return;
    if (!validGuess(m.guess, G.cfg) || m.row !== R.guesses.length || m.row >= G.cfg.rows) return;
    var fb = evaluate(R.secret, m.guess); pushGuess(R, m.guess, fb);
    ui.preview = null;
    if (R === cur()) { Sfx.incoming(); buzz(20); Sfx.key(fb); }
    netSend({ t: 'FEEDBACK', n: R.n, row: m.row, exact: fb.exact, colorOnly: fb.colorOnly });
    if (fb.exact === 4 || R.guesses.length >= G.cfg.rows) {
      netSend({ t: 'REVEAL', n: R.n, secretCode: R.secret, salt: R.salt });
      endRound(R);
    } else if (R === cur()) renderAll();
  }
  function terminal(R) {
    var l = R.guesses[R.guesses.length - 1];
    return !!l && !!l.fb && (l.fb.exact === 4 || R.guesses.length >= G.cfg.rows) && R.guesses.every(function (g) { return g.fb; });
  }
  function onFeedback(m) {
    var R = G.rounds[m.n];
    if (!R || R.maker === G.me || !validFb(m)) return;
    var g = R.guesses[m.row]; if (!g || g.fb) return;
    g.fb = { exact: m.exact, colorOnly: m.colorOnly }; g.order = keyOrder(g.fb);
    if (R === cur()) { ui.fbRow = m.row; Sfx.key(g.fb); buzz(15); renderAll(); }
    tryFinish(R);
  }
  function onReveal(m) {
    var R = G.rounds[m.n];
    if (!R || R.maker === G.me || R.done) return;
    R.revealMsg = { secret: m.secretCode, salt: m.salt };
    tryFinish(R);
  }
  // Codebreaker: check the revealed code against the commitment AND against every feedback row.
  function tryFinish(R) {
    if (R.done || R.finishing || !R.revealMsg || !terminal(R)) return;
    R.finishing = true;
    var sec = R.revealMsg.secret, salt = R.revealMsg.salt;
    MMNet.verifyCommit(sec, salt, R.commit).then(function (okHash) {
      var why = '';
      if (!okHash) why = 'the revealed code does not match the commitment';
      else if (!validCode(sec, G.cfg)) why = 'the code breaks the match rules';
      else {
        var bad = R.guesses.some(function (g) { var e = evaluate(sec, g.guess); return e.exact !== g.fb.exact || e.colorOnly !== g.fb.colorOnly; });
        if (bad) why = 'a key peg did not match the code';
      }
      R.verify = { ok: !why, why: why };
      R.reveal = validGuess(sec, { blank: true }) ? sec : [0, 0, 0, 0];
      R.finishing = false; endRound(R);
    });
  }

  /* ---- resilience: after a drop, both sides exchange what they have and resend the gaps ---- */
  function summary() {
    return G.rounds.map(function (R) { return { c: !!R.commit, g: R.guesses.length, f: R.guesses.filter(function (g) { return g.fb; }).length, d: R.done }; });
  }
  function sendSync() { if (G && G.mode === 'online') netSend({ t: 'SYNC', s: summary() }); }
  function onSync(m) {
    if (!Array.isArray(m.s)) return;
    G.rounds.forEach(function (R, i) {
      var t = m.s[i] || { c: false, g: 0, f: 0, d: false };
      if (R.maker === G.me) {
        if (R.commit && !t.c) netSend({ t: 'ROUND_START', n: i, commit: R.commit });
        for (var j = t.f | 0; j < R.guesses.length; j++) if (R.guesses[j].fb) netSend({ t: 'FEEDBACK', n: i, row: j, exact: R.guesses[j].fb.exact, colorOnly: R.guesses[j].fb.colorOnly });
        if (R.done && !t.d) netSend({ t: 'REVEAL', n: i, secretCode: R.secret, salt: R.salt });
      } else {
        for (var k = t.g | 0; k < R.guesses.length; k++) netSend({ t: 'GUESS', n: i, row: k, guess: R.guesses[k].guess });
      }
    });
  }

  /* ---- reactions ---- */
  function floatEmoji(emoji, from) {
    var f = document.createElement('div'); f.className = 'floater'; f.style.left = (15 + Math.random() * 60) + '%';
    f.innerHTML = emoji + (from ? '<small>' + esc(from) + '</small>' : ''); $('#floaters').appendChild(f);
    setTimeout(function () { f.remove(); }, 2300); if (from) { Sfx.incoming(); buzz(20); }
  }
  $('#btn-react').addEventListener('click', function () { var r = $('#reactbar'); r.hidden = !r.hidden; });
  $('#reactbar').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var emoji = b.dataset.emoji; netSend({ t: 'REACT', emoji: emoji }); floatEmoji(emoji, null); $('#reactbar').hidden = true;
  });

  /* ================= navigation ================= */
  function endSession() { if (S) { try { S.close(); } catch (e) {} S = null; } }
  function goHome() {
    closeModal(); endSession();
    G = null;
    $('#floaters').innerHTML = '';
    refreshHome(); show('home');
  }
  function refreshHome() {
    var saved = LS.get('mm.match', null), rb = $('#btn-resume');
    rb.hidden = !(saved && saved.rounds && saved.rounds.length && !saved.over);
    if (!rb.hidden) $('#resume-info').textContent = saved.names[0] + ' ' + saved.scores[0] + ' – ' + saved.scores[1] + ' ' + saved.names[1] + ' · Round ' + (saved.roundIdx + 1) + ' of ' + saved.cfg.rounds;
    updateOnlineAvail();
    var ib = $('#install-banner'); ib.hidden = isStandalone() || !!LS.get('mm.installDismissed', false);
  }
  $('#btn-home').addEventListener('click', function () {
    if (!G || G.over) return goHome();
    var online = G.mode === 'online';
    openModal('<h3>Leave match?</h3><p>' + (online ? 'Your opponent will be disconnected and this online match will end.' : 'Your progress is saved. Use “Resume match” on the home screen to continue.') + '</p>' +
      '<div class="btnrow"><button class="btn primary" data-act="stay">Keep playing</button><button class="btn ghost" data-act="leave">Leave</button></div>', { stay: closeModal, leave: goHome });
  });
  $$('[data-back]').forEach(function (b) { b.addEventListener('click', function () { show(curScreen === 'online' || curScreen === 'local' ? 'home' : 'online'); }); });
  $('#btn-local').addEventListener('click', function () {
    $('#local-p1').value = names.p1; $('#local-p2').value = names.p2; applyOpts($('#local-opts')); show('local');
  });
  $('#btn-online').addEventListener('click', function () { if (!navigator.onLine) return toast('Online mode requires an internet connection'); show('online'); });
  $('#btn-resume').addEventListener('click', resumeLocal);
  $('#local-start').addEventListener('click', startLocal);
  $('#online-create').addEventListener('click', function () {
    $('#host-name').value = names.host; applyOpts($('#host-opts'));
    $('#host-setup').hidden = false; $('#host-lobby').hidden = true; $('#host-go').disabled = false; show('host');
  });
  $('#online-join').addEventListener('click', function () { showJoin(''); });
  function showJoin(code) {
    $('#join-name').value = names.join; $('#join-code').value = code ? MMNet.formatCode(code) : ''; $('#join-status').textContent = ''; $('#join-dot').hidden = true; $('#join-go').disabled = false; show('join');
  }
  $('#host-go').addEventListener('click', hostCreate);
  $('#host-share').addEventListener('click', shareChallenge);
  $('#code-big').addEventListener('click', function () {
    if (!S || !S.code) return;
    copyText(MMNet.formatCode(S.code)).then(function () { $('#code-hint').textContent = 'Copied!'; setTimeout(function () { $('#code-hint').textContent = 'Tap to copy'; }, 1500); }, function () {});
  });
  $('#host-back').addEventListener('click', function () { endSession(); show('online'); });
  $('#join-back').addEventListener('click', function () { endSession(); show('online'); });
  $('#join-go').addEventListener('click', joinGo);
  $('#join-code').addEventListener('input', function (e) {
    var c = MMNet.normalizeCode(e.target.value); e.target.value = c.length > 3 ? MMNet.formatCode(c) : c;
  });
  $('#lnk-stats').addEventListener('click', showStats);
  $('#lnk-help').addEventListener('click', showHelp);
  $('#lnk-install').addEventListener('click', showInstall);
  $('#ib-guide').addEventListener('click', showInstall);
  $('#ib-close').addEventListener('click', function () { LS.set('mm.installDismissed', true); $('#install-banner').hidden = true; });
  $('#btn-menu').addEventListener('click', showMenu);
  $('#btn-theme').addEventListener('click', function () { settings.theme = settings.theme === 'vintage' ? 'modern' : 'vintage'; saveSettings(); applySettings(); Sfx.pop(); toast(settings.theme === 'vintage' ? 'Vintage 1970s Classic' : 'Modern Goliath Edition'); });
  $('#btn-sound').addEventListener('click', function () { settings.sound = !settings.sound; saveSettings(); applySettings(); Sfx.unlock(); Sfx.pop(); });
  document.addEventListener('pointerdown', function () { Sfx.unlock(); }, { once: true });

  function applySettings() {
    document.body.dataset.theme = settings.theme;
    document.body.classList.toggle('marks', !!settings.marks);
    $('#btn-sound').innerHTML = settings.sound ? '&#128266;' : '&#128263;';
    var tc = document.querySelector('meta[name="theme-color"]'); if (tc) tc.content = settings.theme === 'vintage' ? '#2a1b14' : '#0b0c0f';
  }

  /* ================= boot ================= */
  $('#local-opts').innerHTML = optsHTML(false);
  $('#host-opts').innerHTML = optsHTML(true);
  applySettings(); refreshHome();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
  try {
    var jc = new URLSearchParams(location.search).get('join');
    if (jc) { history.replaceState(null, '', location.pathname); var c = MMNet.normalizeCode(jc); if (c.length === MMNet.CODE_LEN) { if (navigator.onLine) showJoin(c); else toast('Connect to the internet to join a challenge'); } }
  } catch (e) {}
})();
