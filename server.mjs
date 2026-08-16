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

// --- Key Management ---
const VAPID_KEY_FILE = path.join(__dirname, '.vapid.json');
let vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
  subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com'
};

if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  if (fs.existsSync(VAPID_KEY_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(VAPID_KEY_FILE, 'utf8'));
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
    try {
      fs.writeFileSync(VAPID_KEY_FILE, JSON.stringify(vapidKeys, null, 2), 'utf8');
      console.log('🔑 Generated new VAPID keys and saved to .vapid.json');
    } catch (err) {
      console.warn('Could not write .vapid.json:', err.message);
    }
  }
}

// --- Global State & Persistence ---
const DATA_FILE = path.join(__dirname, '.data.json');
let globalCount = 0;
if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (typeof saved.count === 'number' && Number.isFinite(saved.count)) {
      globalCount = saved.count;
    }
  } catch (err) {
    console.warn('Could not read .data.json:', err.message);
  }
}

function saveGlobalCount() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ count: globalCount }, null, 2), 'utf8');
  } catch (err) {
    console.warn('Could not write .data.json:', err.message);
  }
}

// In-memory subscription store: endpoint -> subscription
const subscriptions = new Map();

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
    subscriptions.delete(subscription.endpoint); // Cleanup expired/unregistered subscription
  }
  return response.status;
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
    req.on('end', () => {
      try {
        const sub = JSON.parse(body);
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid subscription structure' }));
        }
        subscriptions.set(sub.endpoint, sub);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'subscribed', total: subscriptions.size }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/count' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ count: globalCount, activePushers: sseClients.size }));
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

        // Send Web Push notification to subscribed devices (excluding sender)
        const payload = JSON.stringify({
          title: data.title || 'Pusher 🔴',
          body: data.body || `The Big Red Button was pushed! (Total count: ${globalCount})`,
          url: data.url || './',
          tag: data.tag || 'pusher-global-counter',
          renotify: true,
          timestamp: Date.now()
        });

        const targets = Array.from(subscriptions.values()).filter(
          sub => !senderEndpoint || sub.endpoint !== senderEndpoint
        );
        const results = await Promise.allSettled(
          targets.map(sub => sendPushNotification(sub, payload))
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          count: globalCount,
          dispatched: targets.length,
          successful: results.filter(r => r.status === 'fulfilled' && (r.value === 201 || r.value === 200 || r.value === 202)).length,
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
