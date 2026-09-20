import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Base64URL Helpers ---
const toB64Url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = (str) => Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// --- Global State & Persistence Directory ---
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : __dirname);
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (err) {
  console.warn(`Could not create DATA_DIR (${DATA_DIR}):`, err.message);
}

function findConfigFile(filename) {
  const primary = path.join(DATA_DIR, filename);
  if (fs.existsSync(primary)) return primary;
  const fallback = path.join(__dirname, filename);
  if (fs.existsSync(fallback)) return fallback;
  return primary;
}

function safeWriteJson(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    console.warn(`Could not write ${path.basename(filePath)}:`, err.message);
  }
}

// --- Key Management ---
const VAPID_KEY_FILE = path.join(DATA_DIR, '.vapid.json');
let vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
  subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com'
};

if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  const vapidSourceFile = findConfigFile('.vapid.json');
  if (fs.existsSync(vapidSourceFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(vapidSourceFile, 'utf8'));
      vapidKeys.publicKey = saved.publicKey;
      vapidKeys.privateKey = saved.privateKey;
      vapidKeys.subject = saved.subject || vapidKeys.subject;
    } catch {
      // Fallback to generation
    }
  }

  if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    vapidKeys.publicKey = toB64Url(ecdh.getPublicKey());
    vapidKeys.privateKey = toB64Url(ecdh.getPrivateKey());
    safeWriteJson(VAPID_KEY_FILE, vapidKeys);
    console.log(`🔑 Generated new VAPID keys and saved to ${VAPID_KEY_FILE}`);
  }
}

// --- Global State & Persistence Files ---
const DATA_FILE = path.join(DATA_DIR, '.data.json');
const SUBS_FILE = path.join(DATA_DIR, '.subscriptions.json');

let globalCount = 0;
const dataSourceFile = findConfigFile('.data.json');
if (fs.existsSync(dataSourceFile)) {
  try {
    const saved = JSON.parse(fs.readFileSync(dataSourceFile, 'utf8'));
    if (typeof saved.count === 'number' && Number.isFinite(saved.count)) {
      globalCount = saved.count;
      console.log(`📊 Loaded global count (${globalCount}) from ${dataSourceFile}`);
    }
  } catch (err) {
    console.warn(`Could not read ${dataSourceFile}:`, err.message);
  }
}

function saveGlobalCount() {
  safeWriteJson(DATA_FILE, { count: globalCount });
}

// Maximum stored push subscriptions (Memory DoS prevention)
const MAX_SUBSCRIPTIONS = 5000;

// Subscription store: endpoint -> subscription (loaded from and persisted to file)
const subscriptions = new Map();

// --- SSRF & Push Endpoint Validation ---
function isValidPushEndpoint(endpointStr) {
  if (typeof endpointStr !== 'string' || !endpointStr.trim()) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(endpointStr);
  } catch {
    return false;
  }

  const allowLocal = process.env.NODE_ENV === 'development' || process.env.ALLOW_LOCAL_PUSH === 'true';
  if (allowLocal) {
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && Boolean(parsed.hostname);
  }

  // Protocol must strictly be https:
  if (parsed.protocol !== 'https:') {
    return false;
  }

  const rawHost = parsed.hostname.toLowerCase();
  const hostname = rawHost.replace(/^\[|\]$/g, '');
  if (!hostname) return false;

  // Hostname must NOT be localhost or end with local/internal domain
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return false;
  }

  // Reject loopback, link-local metadata (169.254.x.x), and private IP ranges
  const ipType = net.isIP(hostname);
  if (ipType === 4) {
    const parts = hostname.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
      return false;
    }
    const [b0, b1] = parts;
    // 0.0.0.0/8 (current network)
    if (b0 === 0) return false;
    // 127.0.0.0/8 (loopback)
    if (b0 === 127) return false;
    // 10.0.0.0/8 (private)
    if (b0 === 10) return false;
    // 172.16.0.0/12 (private: 172.16.0.0 - 172.31.255.255)
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return false;
    // 192.168.0.0/16 (private)
    if (b0 === 192 && b1 === 168) return false;
    // 169.254.0.0/16 (link-local / cloud metadata service)
    if (b0 === 169 && b1 === 254) return false;
    // 100.64.0.0/10 (carrier-grade NAT)
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return false;
    // Broadcast
    if (hostname === '255.255.255.255') return false;
  } else if (ipType === 6) {
    // IPv6 loopback / unspecified
    if (hostname === '::1' || hostname === '::' || hostname === '0:0:0:0:0:0:0:1' || hostname === '0:0:0:0:0:0:0:0') {
      return false;
    }
    // Link-local (fe80::/10) or unique local address (fc00::/7)
    if (/^fe[89ab]/i.test(hostname) || /^f[cd]/i.test(hostname)) {
      return false;
    }
    // IPv4-mapped IPv6
    if (hostname.startsWith('::ffff:')) {
      const v4part = hostname.slice(7);
      if (net.isIP(v4part) === 4) {
        return isValidPushEndpoint(`https://${v4part}/`);
      }
      return false;
    }
  }

  return true;
}

// Sanitize URL for broadcast notifications (Relative path only, prevents open redirects)
function sanitizeRelativeUrl(rawUrl, fallback = './') {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return fallback;
  }
  const trimmed = rawUrl.trim();
  // Reject URLs with explicit schemes (e.g. https:, http:, javascript:, data:)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return fallback;
  }
  // Reject protocol-relative URLs (//) or backslash variants (/\, \\)
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\') || trimmed.startsWith('\\\\')) {
    return fallback;
  }
  // Must start with './' or '/' (single slash)
  if (trimmed.startsWith('./') || (trimmed.startsWith('/') && !trimmed.startsWith('//'))) {
    return trimmed;
  }
  return fallback;
}

const subsSourceFile = findConfigFile('.subscriptions.json');
if (fs.existsSync(subsSourceFile)) {
  try {
    const savedSubs = JSON.parse(fs.readFileSync(subsSourceFile, 'utf8'));
    if (Array.isArray(savedSubs)) {
      for (const sub of savedSubs) {
        if (sub?.endpoint && isValidPushEndpoint(sub.endpoint)) {
          subscriptions.set(sub.endpoint, sub);
          if (subscriptions.size >= MAX_SUBSCRIPTIONS) break;
        }
      }
      console.log(`📱 Loaded ${subscriptions.size} push subscription(s) from ${subsSourceFile}`);
    }
  } catch (err) {
    console.warn(`Could not read ${subsSourceFile}:`, err.message);
  }
}

function saveSubscriptions() {
  safeWriteJson(SUBS_FILE, Array.from(subscriptions.values()));
}

// Active SSE client connections for real-time live pusher updates
const sseClients = new Set();

function broadcastToPushers(type = 'push') {
  const payload = `data: ${JSON.stringify({ type, count: globalCount, timestamp: Date.now() })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Keep-alive heartbeat for SSE connections
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(': keep-alive\n\n');
    } catch {
      sseClients.delete(client);
    }
  }
}, 20000).unref();

// --- 1. VAPID Header Creation (RFC 8292) ---
function createVapidAuthHeader(audienceOrigin) {
  const header = toB64Url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = toB64Url(Buffer.from(JSON.stringify({
    aud: audienceOrigin,
    exp: Math.floor(Date.now() / 1000) + 43200, // 12 hours
    sub: vapidKeys.subject
  })));

  const signInput = `${header}.${payload}`;
  const pubKeyBytes = fromB64Url(vapidKeys.publicKey);

  const privateKey = crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: pubKeyBytes.subarray(1, 33).toString('base64url'),
      y: pubKeyBytes.subarray(33, 65).toString('base64url'),
      d: vapidKeys.privateKey
    },
    format: 'jwk'
  });

  const sig = crypto.sign('SHA256', Buffer.from(signInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363' // Raw 64-byte (r || s) format
  });

  const jwt = `${signInput}.${toB64Url(sig)}`;
  return `vapid t=${jwt}, k=${vapidKeys.publicKey}`;
}

// --- 2. AES-128-GCM Payload Encryption (RFC 8291) ---
function encryptPayload(subscription, text) {
  const clientPublicKey = fromB64Url(subscription.keys.p256dh);
  const clientAuthSecret = fromB64Url(subscription.keys.auth);

  // Ephemeral ECDH key pair
  const serverECDH = crypto.createECDH('prime256v1');
  serverECDH.generateKeys();
  const serverPublicKey = serverECDH.getPublicKey();
  const sharedSecret = serverECDH.computeSecret(clientPublicKey);

  // Derive PRK and IKM via HKDF
  const authInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    clientPublicKey,
    serverPublicKey
  ]);
  const ikm = crypto.hkdfSync('sha256', sharedSecret, clientAuthSecret, authInfo, 32);

  // Derive Content Encryption Key (CEK) and Nonce
  const salt = crypto.randomBytes(16);
  const cek = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  // Encrypt record with AES-128-GCM (payload + record delimiter byte 0x02)
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([2])]);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  // Construct RFC 8291 binary body
  return Buffer.concat([
    salt,
    Buffer.from([0, 0, 16, 0]), // rs = 4096 (4 bytes big-endian)
    Buffer.from([65]),           // idlen = 65 (1 byte)
    serverPublicKey,             // 65 bytes uncompressed
    ciphertext
  ]);
}

// --- 3. Push Message Dispatch ---
async function sendPushNotification(subscription, payloadText) {
  const endpointUrl = new URL(subscription.endpoint);
  const encryptedBody = encryptPayload(subscription, payloadText);
  const authHeader = createVapidAuthHeader(endpointUrl.origin);

  try {
    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'TTL': '60',
        'Urgency': 'high',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Authorization': authHeader,
        'Crypto-Key': `p256ecdsa=${vapidKeys.publicKey}`
      },
      body: encryptedBody
    });

    if (response.status === 404 || response.status === 410) {
      console.log(`🧹 Subscription expired/unregistered (${response.status}) for ${endpointUrl.host}. Removing.`);
      subscriptions.delete(subscription.endpoint);
      saveSubscriptions();
    } else if (response.status !== 200 && response.status !== 201 && response.status !== 202) {
      const errBody = await response.text().catch(() => '');
      console.warn(`⚠️ Push endpoint ${endpointUrl.host} returned ${response.status}:`, errBody);
    }
    return response.status;
  } catch (err) {
    console.error(`❌ Failed to send push to ${endpointUrl.host}:`, err.message);
    return 500;
  }
}

// --- Static File Helper ---
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8'
};

// Files that must never be served statically
const BLOCKED_STATIC_FILES = new Set([
  'server.mjs',
  'dockerfile',
  '.dockerignore',
  '.gitignore',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'readme.md'
]);

function serveStatic(reqMethod, reqPath, res, rawUrl = "") {
  let decodedPath;
  let decodedRaw;
  try {
    decodedPath = decodeURIComponent(reqPath);
    decodedRaw = decodeURIComponent((rawUrl.split('?')[0] || reqPath));
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('400 Bad Request');
  }

  // Reject null bytes
  if (decodedPath.includes('\0') || decodedRaw.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('400 Bad Request');
  }

  // Reject any request where the path or any path segment starts with '.'
  const segments = [
    ...decodedPath.split(/[/\\]+/).filter(Boolean),
    ...decodedRaw.split(/[/\\]+/).filter(Boolean)
  ];
  if (segments.some(segment => segment.startsWith('.'))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }

  const safeBaseDir = path.resolve(__dirname);
  const relativeFile = decodedPath === '/' || decodedPath === '' ? 'index.html' : decodedPath.replace(/^[/\\]+/, '');
  const filePath = path.resolve(safeBaseDir, relativeFile);

  // Verify that the resolved target filePath starts with __dirname (Path Traversal prevention)
  if (!filePath.startsWith(safeBaseDir + path.sep) && filePath !== safeBaseDir) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }

  // Explicitly block serving backend files
  const baseName = path.basename(filePath).toLowerCase();
  if (BLOCKED_STATIC_FILES.has(baseName) || baseName.endsWith('.mjs')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }

  const ext = path.extname(filePath).toLowerCase();

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }

    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': ext === '.html' || ext === '.js' ? 'no-cache' : 'public, max-age=86400'
    });

    if (reqMethod === 'HEAD') {
      return res.end();
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

// --- Request Body Parsing Helper (64KB DoS Prevention) ---
const MAX_BODY_SIZE = 65536; // 64KB

function parseJsonBody(req, res, maxSize = MAX_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let handled = false;

    req.on('data', chunk => {
      if (handled) return;
      size += chunk.length;
      if (size > maxSize) {
        handled = true;
        req.pause();
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
          res.end(JSON.stringify({ error: 'Payload Too Large' }), () => {
            req.socket?.destroy();
          });
        } else {
          req.socket?.destroy();
        }
        const err = new Error('Payload Too Large');
        err.statusCode = 413;
        reject(err);
      } else {
        chunks.push(chunk);
      }
    });

    req.on('end', () => {
      if (handled) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        const data = raw ? JSON.parse(raw) : {};
        resolve(data);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
        const parseErr = new Error('Invalid JSON');
        parseErr.statusCode = 400;
        reject(parseErr);
      }
    });

    req.on('error', (err) => {
      if (!handled) reject(err);
    });
  });
}

// --- HTTP Server ---
const PORT = process.env.PORT || 8080;
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // API Endpoints
  if (url.pathname === '/api/vapid-public-key' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ publicKey: vapidKeys.publicKey }));
  }

  if (url.pathname === '/api/subscribe' && req.method === 'POST') {
    let sub;
    try {
      sub = await parseJsonBody(req, res);
    } catch {
      return;
    }

    try {
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid subscription structure' }));
      }

      if (!isValidPushEndpoint(sub.endpoint)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid or forbidden subscription endpoint' }));
      }

      const isNew = !subscriptions.has(sub.endpoint);
      if (isNew && subscriptions.size >= MAX_SUBSCRIPTIONS) {
        const oldestKey = subscriptions.keys().next().value;
        subscriptions.delete(oldestKey);
      }
      subscriptions.set(sub.endpoint, sub);
      saveSubscriptions();
      console.log(`🔔 Device registered for push notifications (total: ${subscriptions.size})`);

      if (sub.sendConfirmation) {
        const confirmationPayload = JSON.stringify({
          title: 'Pusher 🔴',
          body: 'Push notifications are enabled and ready!',
          url: sanitizeRelativeUrl(sub.url, './'),
          tag: sub.tag || 'pusher-confirm',
          renotify: true,
          timestamp: Date.now()
        });
        sendPushNotification(sub, confirmationPayload).catch(() => {});
      }

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'subscribed', total: subscriptions.size, isNew }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/api/unsubscribe' && req.method === 'POST') {
    let data;
    try {
      data = await parseJsonBody(req, res);
    } catch {
      return;
    }

    try {
      if (data?.endpoint) {
        subscriptions.delete(data.endpoint);
        saveSubscriptions();
        console.log(`🔕 Device unsubscribed (total: ${subscriptions.size})`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'unsubscribed', total: subscriptions.size }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/api/count' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ count: globalCount, activePushers: sseClients.size, activeSubscriptions: subscriptions.size }));
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    // Send initial count immediately upon connection
    res.write(`data: ${JSON.stringify({ type: 'init', count: globalCount })}\n\n`);
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  if (url.pathname === '/api/reset' && req.method === 'POST') {
    globalCount = 0;
    saveGlobalCount();
    broadcastToPushers('reset');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ count: globalCount, status: 'reset' }));
  }

  if ((url.pathname === '/api/broadcast' || url.pathname === '/api/push') && req.method === 'POST') {
    let data;
    try {
      data = await parseJsonBody(req, res);
    } catch {
      return;
    }

    try {
      const senderEndpoint = data.senderEndpoint || data.endpoint || data.sender;

      // Increment global counter
      globalCount++;
      saveGlobalCount();

      // Broadcast updated count in real time to all connected pushers
      broadcastToPushers('push');

      // Sanitize broadcast notification URL
      const sanitizedUrl = sanitizeRelativeUrl(data.url, './');

      // Send Web Push notification to subscribed devices
      const payload = JSON.stringify({
        title: data.title || 'Pusher 🔴',
        body: data.body || `The Big Red Button was pushed! (Total count: ${globalCount})`,
        url: sanitizedUrl,
        tag: data.tag || 'pusher',
        renotify: true,
        timestamp: Date.now()
      });

      // Broadcast to all subscribed devices (or exclude sender ONLY if explicitly set)
      const targets = Array.from(subscriptions.values()).filter(
        sub => !data.excludeSender || !senderEndpoint || sub.endpoint !== senderEndpoint
      );
      const results = await Promise.allSettled(
        targets.map(sub => sendPushNotification(sub, payload))
      );

      const successful = results.filter(
        r => r.status === 'fulfilled' && (r.value === 201 || r.value === 200 || r.value === 202)
      ).length;

      console.log(`📡 Dispatched push to ${targets.length} subscriber(s) (${successful} succeeded)`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        count: globalCount,
        dispatched: targets.length,
        successful,
        activeSubscriptions: subscriptions.size,
        activePushers: sseClients.size
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Static files
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req.method, url.pathname, res, req.url);
  }

  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`🚀 Pusher zero-dependency server running at http://localhost:${PORT}`);
  console.log(`🔑 VAPID Public Key: ${vapidKeys.publicKey}`);
});
