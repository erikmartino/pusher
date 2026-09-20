import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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

// Subscription store: endpoint -> subscription (loaded from and persisted to file)
const subscriptions = new Map();

const subsSourceFile = findConfigFile('.subscriptions.json');
if (fs.existsSync(subsSourceFile)) {
  try {
    const savedSubs = JSON.parse(fs.readFileSync(subsSourceFile, 'utf8'));
    if (Array.isArray(savedSubs)) {
      for (const sub of savedSubs) {
        if (sub?.endpoint) {
          subscriptions.set(sub.endpoint, sub);
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
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Authorization': authHeader
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

function serveStatic(reqMethod, reqPath, res) {
  let filePath = path.join(__dirname, reqPath === '/' ? 'index.html' : reqPath);
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

// --- HTTP Server ---
const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
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
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const sub = JSON.parse(body);
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid subscription structure' }));
        }
        const isNew = !subscriptions.has(sub.endpoint);
        subscriptions.set(sub.endpoint, sub);
        saveSubscriptions();
        console.log(`🔔 Device registered for push notifications (total: ${subscriptions.size})`);

        if (sub.sendConfirmation) {
          const confirmationPayload = JSON.stringify({
            title: 'Pusher 🔴',
            body: 'Push notifications are enabled and ready!',
            url: './',
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
    });
    return;
  }

  if (url.pathname === '/api/unsubscribe' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
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
    });
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
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const senderEndpoint = data.senderEndpoint || data.endpoint || data.sender;

        // Increment global counter
        globalCount++;
        saveGlobalCount();

        // Broadcast updated count in real time to all connected pushers
        broadcastToPushers('push');

        // Send Web Push notification to subscribed devices
        const payload = JSON.stringify({
          title: data.title || 'Pusher 🔴',
          body: data.body || `The Big Red Button was pushed! (Total count: ${globalCount})`,
          url: data.url || './',
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
    });
    return;
  }

  // Static files
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req.method, url.pathname, res);
  }

  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`🚀 Pusher zero-dependency server running at http://localhost:${PORT}`);
  console.log(`🔑 VAPID Public Key: ${vapidKeys.publicKey}`);
});
