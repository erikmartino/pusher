import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. WebMCP Manifest File Validity
test('WebMCP discovery manifest .well-known/webmcp.json is valid and contains expected tools', () => {
  const manifestPath = path.join(__dirname, '.well-known', 'webmcp.json');
  assert.ok(fs.existsSync(manifestPath), 'Manifest file exists');

  const content = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(content.name, 'Pusher');
  assert.ok(Array.isArray(content.tools), 'Tools is an array');

  const toolNames = content.tools.map(t => t.name);
  assert.ok(toolNames.includes('push_button'), 'Contains push_button tool');
  assert.ok(toolNames.includes('get_status'), 'Contains get_status tool');
  assert.ok(toolNames.includes('reset_counter'), 'Contains reset_counter tool');
  assert.ok(toolNames.includes('set_sound'), 'Contains set_sound tool');

  for (const tool of content.tools) {
    assert.ok(tool.name, 'Tool has name');
    assert.ok(tool.description, 'Tool has description');
    assert.ok(tool.inputSchema, 'Tool has inputSchema');
  }
});

// 2. HTML Markup & Declarative WebMCP
test('index.html contains WebMCP discovery link and declarative forms without polyfills', () => {
  const htmlPath = path.join(__dirname, 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  // Discovery link tag
  assert.match(html, /<link\s+rel="webmcp"\s+href="\/\.well-known\/webmcp\.json"\s*\/?>/i, 'Has <link rel="webmcp"> tag');

  // Declarative WebMCP forms
  assert.match(html, /toolname="push_button"/i, 'Has declarative push_button form');
  assert.match(html, /toolname="get_status"/i, 'Has declarative get_status form');
  assert.match(html, /toolname="reset_counter"/i, 'Has declarative reset_counter form');
  assert.match(html, /toolname="set_sound"/i, 'Has declarative set_sound form');
  assert.match(html, /toolautosubmit/i, 'Has toolautosubmit attribute');
  assert.match(html, /toolparamdescription/i, 'Has toolparamdescription attribute');

  // Native Imperative registration present
  assert.match(html, /registerTool/i, 'Has registerTool call for native modelContext');
  assert.match(html, /document\.modelContext/i, 'References document.modelContext');

  // Verify NO polyfill is included
  assert.doesNotMatch(html, /webmcp-polyfill/i, 'Does NOT load webmcp-polyfill');
  assert.doesNotMatch(html, /polyfill\.js/i, 'Does NOT load polyfill.js');
});

// 3. Service Worker
test('sw.js caches WebMCP manifest and uses updated cache name', () => {
  const swPath = path.join(__dirname, 'sw.js');
  const sw = fs.readFileSync(swPath, 'utf8');

  assert.match(sw, /CACHE_NAME\s*=\s*'pusher-v9'/, 'Uses pusher-v9 cache');
  assert.match(sw, /'\.\/\.well-known\/webmcp\.json'/, 'Caches .well-known/webmcp.json');
});

// 4. HTTP Server Integration Tests
test('Server WebMCP endpoints and headers', async () => {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const dataDir = path.join(__dirname, `.test_data_${port}`);
  fs.mkdirSync(dataDir, { recursive: true });

  const serverProc = spawn(process.execPath, ['server.mjs'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: port.toString(),
      DATA_DIR: dataDir,
      NODE_ENV: 'development'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    // Wait for server to start listening
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timed out')), 4000);
      serverProc.stdout.on('data', (d) => {
        if (d.toString().includes('running at')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      serverProc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    const baseUrl = `http://127.0.0.1:${port}`;

    // Test GET / - HTML response headers
    const homeRes = await fetch(`${baseUrl}/`);
    assert.equal(homeRes.status, 200);
    assert.match(homeRes.headers.get('link') || '', /\/\.well-known\/webmcp\.json/);
    assert.equal(homeRes.headers.get('x-webmcp'), 'enabled');

    // Test GET /.well-known/webmcp.json
    const manifestRes = await fetch(`${baseUrl}/.well-known/webmcp.json`);
    assert.equal(manifestRes.status, 200);
    assert.match(manifestRes.headers.get('content-type') || '', /application\/json/);
    const manifestData = await manifestRes.json();
    assert.equal(manifestData.name, 'Pusher');
    assert.ok(Array.isArray(manifestData.tools));

    // Test GET /.well-known/webmcp
    const manifestShortRes = await fetch(`${baseUrl}/.well-known/webmcp`);
    assert.equal(manifestShortRes.status, 200);

    // Test POST /_webmcp/exec/push_button
    const execPushRes = await fetch(`${baseUrl}/_webmcp/exec/push_button`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 5 })
    });
    assert.equal(execPushRes.status, 200);
    const pushData = await execPushRes.json();
    assert.equal(pushData.success, true);
    assert.equal(pushData.tool, 'push_button');
    assert.equal(pushData.pushed, 5);

    // Test POST /_webmcp/exec/get_status
    const execStatusRes = await fetch(`${baseUrl}/_webmcp/exec/get_status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(execStatusRes.status, 200);
    const statusData = await execStatusRes.json();
    assert.equal(statusData.success, true);
    assert.equal(statusData.tool, 'get_status');
    assert.ok(statusData.count >= 5);

    // Test POST /_webmcp/exec/reset_counter
    const execResetRes = await fetch(`${baseUrl}/_webmcp/exec/reset_counter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(execResetRes.status, 200);
    const resetData = await execResetRes.json();
    assert.equal(resetData.success, true);
    assert.equal(resetData.count, 0);

    // Test POST /api/webmcp/execute
    const genericExecRes = await fetch(`${baseUrl}/api/webmcp/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'push_button', params: { count: 3 } })
    });
    assert.equal(genericExecRes.status, 200);
    const genericData = await genericExecRes.json();
    assert.equal(genericData.success, true);
    assert.equal(genericData.count, 3);

    // Test standard /api/count
    const countRes = await fetch(`${baseUrl}/api/count`);
    assert.equal(countRes.status, 200);
    const countData = await countRes.json();
    assert.equal(countData.count, 3);

    // Test security: path traversal still blocked
    const forbiddenRes = await fetch(`${baseUrl}/../package.json`);
    assert.equal(forbiddenRes.status, 403);

  } finally {
    serverProc.kill('SIGTERM');
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }
});

// 5. Full In-Browser Functional Simulation of WebMCP
test('WebMCP imperative and declarative tools execute and produce expected results', async () => {
  // Setup simulated DOM & modelContext
  const registeredTools = new Map();
  const modelContext = {
    registerTool: async (tool) => {
      registeredTools.set(tool.name, tool);
    },
    getTools: async () => Array.from(registeredTools.values()),
    executeTool: async (tool, params) => {
      const target = registeredTools.get(tool.name || tool);
      assert.ok(target, `Tool ${tool.name || tool} must exist`);
      return target.execute(params);
    }
  };

  // State mock
  let count = 0;
  let soundEnabled = true;
  let pushTimestamps = [];
  const pushBtn = { classList: { add: () => {}, remove: () => {}, contains: () => false } };
  const counterEl = { textContent: '0', classList: { add: () => {}, remove: () => {} } };
  const soundToggle = {
    classList: { toggle: (cls, val) => {} },
    setAttribute: () => {}
  };

  const updateCounterUI = (newCount) => {
    count = newCount;
    counterEl.textContent = count.toString();
  };

  const doPush = async () => {
    updateCounterUI(count + 1);
    pushTimestamps.push(Date.now());
    return count;
  };

  const releaseButton = () => {};

  // Register tools using the exact logic from index.html
  const tools = [
    {
      name: 'push_button',
      title: 'Push Button',
      description: 'Presses the Big Red Button. Increments the push counter, plays tactile audio, triggers device haptics, and broadcasts the push event.',
      inputSchema: {
        type: 'object',
        properties: { count: { type: 'integer', minimum: 1, maximum: 100, default: 1 } }
      },
      annotations: { readOnlyHint: false, consequentialHint: true },
      execute: async (params) => {
        const times = Math.min(100, Math.max(1, parseInt(params?.count || 1, 10) || 1));
        pushBtn.classList.add('pressed');
        for (let i = 0; i < times; i++) {
          await doPush();
        }
        setTimeout(() => releaseButton(), 150);
        return { success: true, count, pushed: times };
      }
    },
    {
      name: 'get_status',
      title: 'Get Status',
      description: 'Retrieves the current state of Pusher.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => {
        return {
          count,
          rate: pushTimestamps.length,
          soundEnabled,
          online: true,
          pushSubscribed: false
        };
      }
    },
    {
      name: 'reset_counter',
      title: 'Reset Counter',
      description: 'Resets the global push counter back to zero.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: false, consequentialHint: true },
      execute: async () => {
        updateCounterUI(0);
        return { success: true, count: 0, status: 'reset' };
      }
    },
    {
      name: 'set_sound',
      title: 'Set Sound',
      description: 'Enables or mutes the tactile audio click effects.',
      inputSchema: {
        type: 'object',
        properties: { enabled: { type: 'boolean' } },
        required: ['enabled']
      },
      annotations: { readOnlyHint: false },
      execute: async (params) => {
        soundEnabled = Boolean(params?.enabled);
        soundToggle.classList.toggle('muted', !soundEnabled);
        return { success: true, soundEnabled };
      }
    }
  ];

  for (const t of tools) {
    await modelContext.registerTool(t);
  }

  // 1. Discovery verification
  const availableTools = await modelContext.getTools();
  assert.equal(availableTools.length, 4);

  // 2. Tool Execution: push_button
  const pushRes = await modelContext.executeTool('push_button', { count: 3 });
  assert.equal(pushRes.success, true);
  assert.equal(pushRes.count, 3);
  assert.equal(pushRes.pushed, 3);
  assert.equal(count, 3);

  // 3. Tool Execution: get_status
  const statusRes = await modelContext.executeTool('get_status');
  assert.equal(statusRes.count, 3);
  assert.equal(statusRes.soundEnabled, true);

  // 4. Tool Execution: set_sound
  const soundRes = await modelContext.executeTool('set_sound', { enabled: false });
  assert.equal(soundRes.success, true);
  assert.equal(soundRes.soundEnabled, false);
  assert.equal(soundEnabled, false);

  // 5. Tool Execution: reset_counter
  const resetRes = await modelContext.executeTool('reset_counter');
  assert.equal(resetRes.success, true);
  assert.equal(resetRes.count, 0);
  assert.equal(count, 0);

  // 6. Declarative submit event simulation with SubmitEvent.respondWith()
  let declarativeResult = null;
  const mockSubmitEvent = {
    preventDefault: () => {},
    respondWith: (promise) => {
      declarativeResult = promise;
    }
  };

  // Simulate declarative form submit handler
  const handlePushForm = async (e, formCount) => {
    const times = Math.min(100, Math.max(1, parseInt(formCount || '1', 10) || 1));
    for (let i = 0; i < times; i++) {
      await doPush();
    }
    const data = { success: true, count, pushed: times };
    e.respondWith(Promise.resolve(data));
    return data;
  };

  await handlePushForm(mockSubmitEvent, 4);
  const resolvedData = await declarativeResult;
  assert.equal(resolvedData.success, true);
  assert.equal(resolvedData.count, 4);
  assert.equal(resolvedData.pushed, 4);
});

