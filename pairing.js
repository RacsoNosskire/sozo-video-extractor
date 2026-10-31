// AniList sign-in for TVs, through a phone. The TV gets a code and a device secret from
// /auth/pair and shows a QR code for /auth/login?code=…; the phone signs in to AniList there and
// posts the token to /auth/complete; the TV collects it from /auth/poll with its secret. The code
// travels on screen, so it only lets a phone hand a token over: only the secret takes one out.

const crypto = require('crypto');
const express = require('express');
const { publicBase } = require('./proxy');

const PAIR_TTL = 5 * 60 * 1000; // 5 min
const MAX_SESSIONS = 100;
const MAX_TOKEN_LENGTH = 4096;
const ANILIST_CLIENT_ID = '38692';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I; 32 letters
const CODE_LENGTH = 8;

// `byte % 32` is even across the alphabet.
const generateCode = () => [...crypto.randomBytes(CODE_LENGTH)].map((b) => CODE_ALPHABET[b % 32]).join('');
const generateSecret = () => crypto.randomBytes(32).toString('hex');

function sameSecret(a, b) {
    const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
    return crypto.timingSafeEqual(hash(a), hash(b));
}

// At most `limit` requests a minute from one client. Behind nginx every request comes from
// nginx, which names the real client in X-Real-IP.
function rateLimit(limit, windowMs = 60_000) {
    const hits = new Map();
    return (req, res, next) => {
        const client = req.get('x-real-ip') || req.socket.remoteAddress;
        const now = Date.now();
        if (hits.size > 10_000) hits.clear();
        let entry = hits.get(client);
        if (!entry || now - entry.start > windowMs) {
            entry = { start: now, count: 0 };
            hits.set(client, entry);
        }
        entry.count += 1;
        if (entry.count > limit) return res.status(429).json({ status: 'error', ok: false, error: 'Too many requests' });
        next();
    };
}

function loginPage(code, origin) {
    // Both end up inside a script: JSON keeps them strings, the escape keeps </script> out.
    const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sozo TV Login</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #141414; color: #e5e5e5;
         display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
  .box { text-align: center; max-width: 420px; width: 100%; }
  h2 { color: #E50914; margin-bottom: 8px; }
  p { line-height: 1.5; }
  .ok { color: #4caf50; }
  .err { color: #E50914; }
  .btn { display: inline-block; background: #E50914; color: white; padding: 14px 32px; border-radius: 4px;
         font-size: 18px; font-weight: bold; text-decoration: none; margin-top: 16px; }
  .btn:hover { background: #c40812; }
  #token-section { display: none; margin-top: 20px; }
  textarea { width: 100%; height: 60px; background: #2a2a2a; border: 1px solid #555; color: white;
             border-radius: 4px; padding: 10px; font-size: 14px; resize: vertical; margin-top: 8px; }
  .submit-btn { background: #E50914; color: white; padding: 10px 24px; border: none; border-radius: 4px;
                font-size: 16px; cursor: pointer; margin-top: 8px; }
</style></head><body>
<div class="box">
  <div id="step1">
    <h2>Sozo TV Login</h2>
    <p>Pairing code: <strong style="color:#E50914;font-size:1.4em;letter-spacing:3px">${code}</strong></p>
    <a class="btn" href="https://anilist.co/api/v2/oauth/authorize?client_id=${ANILIST_CLIENT_ID}&response_type=token">Login with AniList</a>
    <p style="color:#808080;font-size:13px;margin-top:20px">After login, AniList shows your token on a page.<br>Copy it and paste below.</p>
  </div>
  <div id="token-section">
    <h2>Paste your token</h2>
    <p style="color:#808080;font-size:14px">After authorizing, AniList shows a page with your token. Copy the entire token and paste it here:</p>
    <textarea id="token-input" placeholder="Paste access token here..."></textarea>
    <br><button class="submit-btn" onclick="sendToken()">Send to TV</button>
    <p id="result"></p>
  </div>
  <div id="done" style="display:none">
    <h2 class="ok">Connected!</h2>
    <p>You can close this page and return to your TV.</p>
  </div>
</div>
<script>
// Show token input after clicking the AniList link
document.querySelector('.btn').addEventListener('click', function() {
  setTimeout(function() { document.getElementById('token-section').style.display = 'block'; }, 1000);
});
// Also check if we came back with a hash fragment (some flows)
if (window.location.hash.includes('access_token')) {
  var hash = window.location.hash.substring(1);
  var params = {};
  hash.split('&').forEach(function(p) { var kv = p.split('='); if(kv.length===2) params[kv[0]]=kv[1]; });
  if (params['access_token']) {
    document.getElementById('token-input').value = params['access_token'];
    document.getElementById('token-section').style.display = 'block';
    sendToken();
  }
}
function sendToken() {
  var raw = document.getElementById('token-input').value.trim();
  var token = raw;
  if (raw.includes('access_token=')) { token = raw.split('access_token=')[1].split('&')[0]; }
  if (!token || token.length < 20) {
    document.getElementById('result').innerHTML = '<span class="err">Token looks too short. Make sure you copied the full token.</span>';
    return;
  }
  document.getElementById('result').innerHTML = 'Sending...';
  fetch(${js(`${origin}/auth/complete`)}, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: ${js(code)}, token: token })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.ok) {
      document.getElementById('token-section').style.display = 'none';
      document.getElementById('step1').style.display = 'none';
      document.getElementById('done').style.display = 'block';
    } else {
      document.getElementById('result').textContent = d.error || 'Failed';
      document.getElementById('result').className = 'err';
    }
  }).catch(function(e) {
    document.getElementById('result').textContent = e.message;
    document.getElementById('result').className = 'err';
  });
}
</script></body></html>`;
}

function mount(app) {
    // code → { secret, token, createdAt }
    const sessions = new Map();
    const live = (code) => {
        const s = typeof code === 'string' ? sessions.get(code) : undefined;
        if (s && Date.now() - s.createdAt > PAIR_TTL) {
            sessions.delete(code);
            return undefined;
        }
        return s;
    };
    const sweep = setInterval(() => [...sessions.keys()].forEach(live), 60_000);
    sweep.unref();

    // TV calls this to create a pairing session → returns { code, secret }
    app.get('/auth/pair', rateLimit(10), (req, res) => {
        [...sessions.keys()].forEach(live);
        if (sessions.size >= MAX_SESSIONS) return res.status(429).json({ error: 'Too many pairing sessions' });
        let code;
        do { code = generateCode(); } while (sessions.has(code));
        const secret = generateSecret();
        sessions.set(code, { secret, token: null, createdAt: Date.now() });
        console.log('[PAIR] Session created');
        res.json({ code, secret });
    });

    // Phone opens this URL (from QR) → shows a page that handles the full OAuth flow client-side
    app.get('/auth/login', rateLimit(30), (req, res) => {
        const code = req.query.code;
        if (!live(code)) return res.status(400).send('Invalid or expired pairing code.');
        res.type('html').send(loginPage(code, publicBase(req)));
    });

    // Phone's callback page POSTs the token here. A code takes one token: after that a guessed
    // code can't swap in another account's.
    app.post('/auth/complete', rateLimit(20), express.json({ limit: '16kb' }), (req, res) => {
        const { code, token } = req.body || {};
        if (!code || !token) return res.json({ ok: false, error: 'Missing code or token' });
        if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return res.json({ ok: false, error: 'Bad token' });
        const session = live(code);
        if (!session || session.token) return res.json({ ok: false, error: 'Invalid or expired code' });
        session.token = token;
        console.log('[PAIR] Token received');
        res.json({ ok: true });
    });

    // TV polls this until the token arrives. The secret comes in a header, out of access logs.
    app.get('/auth/poll', rateLimit(120), (req, res) => {
        const code = req.query.code;
        if (!code) return res.json({ status: 'error', error: 'Missing code' });
        const session = live(code);
        if (!session) return res.json({ status: 'expired' });
        if (!sameSecret(req.get('x-device-secret') || '', session.secret)) {
            return res.status(403).json({ status: 'error', error: 'Wrong device secret' });
        }
        if (session.token) {
            const token = session.token;
            sessions.delete(code); // one-time use
            return res.json({ status: 'ok', token });
        }
        res.json({ status: 'waiting' });
    });
}

module.exports = { mount, rateLimit, loginPage, generateCode, generateSecret };
