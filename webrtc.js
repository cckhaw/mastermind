/* Mastermind — WebRTC transport, challenge codes, commit-reveal helpers.
 *
 * Zero-backend multiplayer: PeerJS public cloud is used ONLY as a signaling relay
 * to broker an RTCDataChannel; after that, all game traffic is peer-to-peer.
 * Loaded after vendor/peerjs.min.js (bundled locally so the app boots offline).
 */
(function (global) {
  'use strict';

  // 32 chars, no I / O / 0 / 1 — unambiguous when read aloud or typed from a phone screen.
  var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var ROOM_PREFIX = 'mastermind-p2p-';
  var CODE_LEN = 6;
  var ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];
  var HEARTBEAT_MS = 4000;
  var STALE_MS = 15000;
  var RECOVER_WINDOW_MS = 120000;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function randomBytes(n) {
    var b = new Uint8Array(n);
    (global.crypto || global.msCrypto).getRandomValues(b);
    return b;
  }
  function randomHex(n) {
    return Array.prototype.map.call(randomBytes(n), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }

  /* ---------- challenge codes ---------- */
  function genCode() {
    var b = randomBytes(CODE_LEN), s = '';
    for (var i = 0; i < CODE_LEN; i++) s += ALPHABET[b[i] & 31]; // 32 | 256 → no modulo bias
    return s;
  }
  function normalizeCode(input) {
    var s = String(input || '').toUpperCase(), out = '';
    for (var i = 0; i < s.length; i++) if (ALPHABET.indexOf(s[i]) >= 0) out += s[i];
    return out.slice(0, CODE_LEN);
  }
  function formatCode(code) { return code.slice(0, 3) + '-' + code.slice(3); }
  function roomId(code) { return ROOM_PREFIX + normalizeCode(code); }

  /* ---------- SHA-256 (WebCrypto with a pure-JS fallback for non-secure origins) ---------- */
  function sha256Fallback(str) {
    var utf8 = unescape(encodeURIComponent(str)), bytes = [], i;
    for (i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i));
    var K = [], p = 2, n = 0;
    function isPrime(x) { for (var d = 2; d * d <= x; d++) if (x % d === 0) return false; return true; }
    while (n < 64) { if (isPrime(p)) { K.push((Math.pow(p, 1 / 3) % 1 * 4294967296) | 0); n++; } p++; }
    var H = [], q = 2; n = 0;
    while (n < 8) { if (isPrime(q)) { H.push((Math.pow(q, 1 / 2) % 1 * 4294967296) | 0); n++; } q++; }
    var l = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (l >>> (i * 8)) & 255);
    function rr(x, c) { return (x >>> c) | (x << (32 - c)); }
    for (var off = 0; off < bytes.length; off += 64) {
      var w = [];
      for (i = 0; i < 16; i++) w[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3];
      for (i = 16; i < 64; i++) {
        var s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25), ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22), mj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
  }
  function sha256Hex(str) {
    var subtle = global.crypto && global.crypto.subtle;
    if (!subtle) return Promise.resolve(sha256Fallback(str));
    return subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    }).catch(function () { return sha256Fallback(str); });
  }

  /* ---------- commit / reveal ---------- */
  function commitString(secret, salt) { return secret.join(',') + '|' + salt; }
  function makeCommit(secret) {
    var salt = randomHex(16);
    return sha256Hex(commitString(secret, salt)).then(function (hash) { return { salt: salt, commit: hash }; });
  }
  function verifyCommit(secret, salt, commit) {
    if (!Array.isArray(secret) || typeof salt !== 'string') return Promise.resolve(false);
    return sha256Hex(commitString(secret, salt)).then(function (h) { return h === commit; });
  }

  /* ---------- tiny emitter ---------- */
  function Emitter() { this._h = {}; }
  Emitter.prototype.on = function (ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; };
  Emitter.prototype.emit = function (ev, a, b) {
    var l = this._h[ev]; if (!l) return;
    l.slice().forEach(function (fn) { try { fn(a, b); } catch (e) { console.error(e); } });
  };

  /* ---------- Session: one host or guest endpoint ---------- */
  function Session() {
    Emitter.call(this);
    this.role = null; this.code = null; this.peer = null; this.conn = null;
    this.sid = randomHex(8); this.guestSid = null; this.name = '';
    this.status = 'idle'; this.lastSeen = 0; this.closed = false;
    this.everConnected = false; this.recovering = false;
    this._hb = null; this._hostTimer = null;
    var self = this;
    this._onVis = function () { if (document.visibilityState === 'visible') self.wake(); };
    this._onNet = function () { if (navigator.onLine) self.wake(); else self._setStatus('offline'); };
    document.addEventListener('visibilitychange', this._onVis);
    global.addEventListener('online', this._onNet);
    global.addEventListener('offline', this._onNet);
    global.addEventListener('pageshow', this._onVis);
  }
  Session.prototype = Object.create(Emitter.prototype);

  Session.prototype._setStatus = function (s) {
    if (this.status === s) return;
    this.status = s; this.emit('status', s);
  };

  Session.prototype._peerOpts = function () {
    return { debug: 0, config: { iceServers: ICE_SERVERS, sdpSemantics: 'unified-plan' } };
  };

  Session.prototype._openPeer = function (id) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (!global.Peer) { reject({ type: 'no-peerjs' }); return; }
      var p = id ? new global.Peer(id, self._peerOpts()) : new global.Peer(self._peerOpts());
      var opened = false;
      var t = setTimeout(function () { if (!opened) { try { p.destroy(); } catch (e) {} reject({ type: 'timeout' }); } }, 12000);
      p.on('open', function () { opened = true; clearTimeout(t); resolve(p); });
      p.on('error', function (e) {
        if (!opened) { clearTimeout(t); try { p.destroy(); } catch (x) {} reject(e || { type: 'error' }); }
        else self._peerError(e);
      });
      p.on('disconnected', function () {
        if (opened && !self.closed && self.peer === p) { try { p.reconnect(); } catch (e) {} }
      });
    });
  };

  Session.prototype._peerError = function (e) {
    var t = e && e.type;
    if (t === 'peer-unavailable' || t === 'unavailable-id') return; // handled by dial / host()
    this.emit('error', e);
  };

  /* Host ------------------------------------------------------------ */
  Session.prototype.host = function (name) {
    var self = this;
    this.role = 'host'; this.name = name || '';
    this._setStatus('connecting');
    function attempt(n) {
      var code = genCode();
      return self._openPeer(roomId(code)).then(function (p) { self.peer = p; self.code = code; return code; }, function (e) {
        if (e && e.type === 'unavailable-id' && n < 6) return attempt(n + 1);
        throw e;
      });
    }
    return attempt(0).then(function (code) {
      self.peer.on('connection', function (c) { self._hostIncoming(c); });
      self._setStatus('waiting');
      self._startHeartbeat();
      self._hostTimer = setInterval(function () { self._hostEnsurePeer(); }, 3500);
      return code;
    });
  };

  Session.prototype._hostEnsurePeer = function () {
    var self = this;
    if (this.closed || !this.code) return;
    if (!navigator.onLine) return;
    if (this.peer && !this.peer.destroyed) {
      if (this.peer.disconnected) { try { this.peer.reconnect(); } catch (e) {} }
      return;
    }
    if (this._reopening) return;
    this._reopening = true;
    this._openPeer(roomId(this.code)).then(function (p) {
      self.peer = p; p.on('connection', function (c) { self._hostIncoming(c); });
    }, function () {}).then(function () { self._reopening = false; });
  };

  Session.prototype._hostIncoming = function (c) {
    var self = this;
    c.on('data', function (d) {
      if (!d || typeof d !== 'object') return;
      if (d.t === 'HELLO') return self._hostHello(c, d);
      if (c !== self.conn) return;
      self._onData(d);
    });
    c.on('close', function () { self._onConnClose(c); });
    c.on('error', function () {});
  };

  Session.prototype._hostHello = function (c, d) {
    var busy = this.everConnected && d.sid !== this.guestSid;
    if (busy) { try { c.send({ t: 'BUSY' }); } catch (e) {} setTimeout(function () { try { c.close(); } catch (e) {} }, 400); return; }
    var old = this.conn;
    this.conn = c; this.guestSid = d.sid; this.lastSeen = Date.now();
    if (old && old !== c) { try { old.close(); } catch (e) {} }
    c.send({ t: 'HELLO_ACK', name: this.name });
    var first = !this.everConnected;
    this.everConnected = true;
    this._setStatus('connected');
    if (first) this.emit('open', { name: String(d.name || 'Guest') });
    else this.emit('reconnected');
  };

  /* Guest ----------------------------------------------------------- */
  Session.prototype.join = function (code, name) {
    var self = this;
    this.role = 'guest'; this.code = normalizeCode(code); this.name = name || '';
    this._setStatus('connecting');
    return this._openPeer().then(function (p) {
      self.peer = p;
      return self._dial(15000);
    }).then(function (res) {
      if (!res.ok) { try { self.peer.destroy(); } catch (e) {} throw res.err || { type: 'peer-unavailable' }; }
      self.everConnected = true;
      self._startHeartbeat();
      self.emit('open', { name: res.hostName });
    });
  };

  // Try to open a DataChannel to the host; resolves {ok, hostName, err}.
  Session.prototype._dial = function (timeoutMs) {
    var self = this;
    return new Promise(function (resolve) {
      var done = false, c, t;
      function finish(r) {
        if (done) return; done = true; clearTimeout(t);
        try { self.peer.off('error', onErr); } catch (e) {}
        if (!r.ok && c && c !== self.conn) { try { c.close(); } catch (e) {} }
        resolve(r);
      }
      function onErr(e) { if (e && e.type === 'peer-unavailable') finish({ ok: false, err: e }); }
      self.peer.on('error', onErr);
      t = setTimeout(function () { finish({ ok: false, err: { type: 'timeout' } }); }, timeoutMs);
      try { c = self.peer.connect(roomId(self.code), { reliable: true, serialization: 'json' }); }
      catch (e) { finish({ ok: false, err: e }); return; }
      c.on('open', function () { c.send({ t: 'HELLO', sid: self.sid, name: self.name }); });
      c.on('data', function (d) {
        if (!d || typeof d !== 'object') return;
        if (d.t === 'HELLO_ACK' && !done) {
          var old = self.conn; self.conn = c; self.lastSeen = Date.now();
          if (old && old !== c) { try { old.close(); } catch (e) {} }
          self._setStatus('connected');
          finish({ ok: true, hostName: String(d.name || 'Host') });
          return;
        }
        if (d.t === 'BUSY') { finish({ ok: false, err: { type: 'busy' } }); return; }
        if (c === self.conn) self._onData(d);
      });
      c.on('close', function () { if (!done) finish({ ok: false, err: { type: 'closed' } }); else self._onConnClose(c); });
      c.on('error', function () {});
    });
  };

  Session.prototype._recover = function () {
    var self = this;
    if (this.role !== 'guest' || this.recovering || this.closed) return;
    this.recovering = true;
    this._setStatus('reconnecting');
    var start = Date.now(), delay = 700;
    (function loop() {
      if (self.closed) { self.recovering = false; return; }
      if (Date.now() - start > RECOVER_WINDOW_MS) {
        self.recovering = false; self._setStatus('offline'); self.emit('closed', { reason: 'timeout' }); return;
      }
      if (!navigator.onLine) { setTimeout(loop, 1000); return; }
      var ready;
      if (!self.peer || self.peer.destroyed) {
        ready = self._openPeer().then(function (p) { self.peer = p; });
      } else if (self.peer.disconnected) {
        try { self.peer.reconnect(); } catch (e) {}
        ready = sleep(900);
      } else ready = Promise.resolve();
      ready.then(function () { return self._dial(8000); }).then(function (r) {
        if (r.ok) { self.recovering = false; self.emit('reconnected'); return; }
        if (r.err && r.err.type === 'busy') { self.recovering = false; self._setStatus('offline'); self.emit('closed', { reason: 'busy' }); return; }
        delay = Math.min(delay * 1.5, 5000); setTimeout(loop, delay);
      }, function () { delay = Math.min(delay * 1.5, 5000); setTimeout(loop, delay); });
    })();
  };

  /* Shared ---------------------------------------------------------- */
  Session.prototype._onData = function (d) {
    this.lastSeen = Date.now();
    if (this.status === 'reconnecting' && this.conn && this.conn.open) this._setStatus('connected');
    switch (d.t) {
      case 'PING': this._raw({ t: 'PONG', ts: d.ts }); return;
      case 'PONG': this.emit('rtt', Date.now() - d.ts); return;
      case 'BYE': this._peerLeft = true; this.emit('closed', { reason: 'left' }); return;
      case 'HELLO_ACK': case 'HELLO': case 'BUSY': return;
    }
    this.emit('msg', d);
  };

  Session.prototype._onConnClose = function (c) {
    if (c !== this.conn || this.closed || this._peerLeft) return;
    this._setStatus('reconnecting');
    if (this.role === 'guest') this._recover();
  };

  Session.prototype._raw = function (obj) {
    if (this.conn && this.conn.open) { try { this.conn.send(obj); return true; } catch (e) {} }
    return false;
  };
  Session.prototype.send = function (obj) { return this._raw(obj); };
  Session.prototype.isOpen = function () { return !!(this.conn && this.conn.open) && this.status === 'connected'; };

  Session.prototype._startHeartbeat = function () {
    var self = this;
    clearInterval(this._hb);
    this._hb = setInterval(function () {
      if (self.closed || !self.everConnected) return;
      if (!navigator.onLine) { self._setStatus('offline'); return; }
      self._raw({ t: 'PING', ts: Date.now() });
      if (self.lastSeen && Date.now() - self.lastSeen > STALE_MS && self.status === 'connected') {
        self._setStatus('reconnecting');
        if (self.role === 'guest') { try { self.conn && self.conn.close(); } catch (e) {} self._recover(); }
      }
    }, HEARTBEAT_MS);
  };

  // Called when the PWA returns to the foreground / network returns.
  Session.prototype.wake = function () {
    if (this.closed || !this.everConnected) return;
    this._raw({ t: 'PING', ts: Date.now() });
    if (this.role === 'guest') {
      if (!(this.conn && this.conn.open)) this._recover();
      else if (this.lastSeen && Date.now() - this.lastSeen > STALE_MS) { try { this.conn.close(); } catch (e) {} this._recover(); }
    } else this._hostEnsurePeer();
  };

  Session.prototype.close = function () {
    if (this.closed) return;
    this._raw({ t: 'BYE' });
    this.closed = true;
    clearInterval(this._hb); clearInterval(this._hostTimer);
    document.removeEventListener('visibilitychange', this._onVis);
    global.removeEventListener('online', this._onNet);
    global.removeEventListener('offline', this._onNet);
    global.removeEventListener('pageshow', this._onVis);
    var self = this;
    setTimeout(function () {
      try { self.conn && self.conn.close(); } catch (e) {}
      try { self.peer && self.peer.destroy(); } catch (e) {}
    }, 150);
    this._setStatus('idle');
  };

  global.MMNet = {
    Session: Session, genCode: genCode, normalizeCode: normalizeCode, formatCode: formatCode,
    roomId: roomId, sha256Hex: sha256Hex, makeCommit: makeCommit, verifyCommit: verifyCommit,
    ICE_SERVERS: ICE_SERVERS, CODE_LEN: CODE_LEN
  };
})(window);
