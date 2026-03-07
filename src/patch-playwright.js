#!/usr/bin/env node
/**
 * patch-playwright.js (plain JavaScript — runs as postinstall)
 *
 * Applies rebrowser-patches-style Runtime.enable suppression to playwright-core.
 * Must run BEFORE the app starts so patches are in effect when modules load.
 *
 * Run: node src/patch-playwright.js
 * Or automatically via "postinstall" in package.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Find playwright-core from __dirname (src/ or wherever this file lives)
function findPlaywrightCore() {
  const dirs = [
    path.join(__dirname, '..', 'node_modules', 'playwright-core'),
    path.join(__dirname, '..', '..', 'node_modules', 'playwright-core'),
    path.join(__dirname, 'node_modules', 'playwright-core'),
  ];
  for (const d of dirs) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d;
  }
  try {
    return path.dirname(path.dirname(require.resolve('playwright-core/package.json')));
  } catch { return null; }
}

const base = findPlaywrightCore();
if (!base) {
  console.log('[patch-playwright] playwright-core not found, skipping');
  process.exit(0);
}

const CHROMIUM = path.join(base, 'lib', 'server', 'chromium');
const SERVER = path.join(base, 'lib', 'server');
let patched = 0;
let skipped = 0;

function patchFile(filePath, label, search, replace) {
  if (!fs.existsSync(filePath)) { skipped++; return; }
  let c = fs.readFileSync(filePath, 'utf8');
  if (c.includes('REBROWSER_PATCHES_RUNTIME_FIX_MODE') || c.includes('__re__emitExecutionContext')) {
    skipped++; return;  // already patched
  }
  if (!c.includes(search)) { skipped++; return; }
  c = c.replace(search, replace);
  fs.writeFileSync(filePath, c);
  console.log('[patch-playwright] patched ' + label);
  patched++;
}

// 1. crDevTools.js
patchFile(
  path.join(CHROMIUM, 'crDevTools.js'),
  'crDevTools.js Runtime.enable',
  'session.send("Runtime.enable"),',
  '(() => { if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] === "0") { return session.send("Runtime.enable"); } })(),'
);

// 2. crPage.js (main session)
patchFile(
  path.join(CHROMIUM, 'crPage.js'),
  'crPage.js Runtime.enable (main)',
  'this._client.send("Runtime.enable", {}),',
  '(() => { if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] === "0") { return this._client.send("Runtime.enable", {}); } })(),'
);

// 3. crPage.js (worker session) — separate pass
patchFile(
  path.join(CHROMIUM, 'crPage.js'),
  'crPage.js Runtime.enable (worker)',
  'session._sendMayFail("Runtime.enable");',
  'if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] === "0") { session._sendMayFail("Runtime.enable"); }'
);

// 4. crServiceWorker.js
patchFile(
  path.join(CHROMIUM, 'crServiceWorker.js'),
  'crServiceWorker.js Runtime.enable',
  'session.send("Runtime.enable", {}).catch((e) => {\n    });',
  'if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] === "0") { session.send("Runtime.enable", {}).catch((e) => {}); }'
);

// 5. crConnection.js — add __re__ execution context methods
{
  const fp = path.join(CHROMIUM, 'crConnection.js');
  if (fs.existsSync(fp)) {
    let c = fs.readFileSync(fp, 'utf8');
    if (!c.includes('__re__emitExecutionContext')) {
      const search = '  this._callbacks.clear();\n  }\n}\nclass CDPSession';
      if (c.includes(search)) {
        const replace = `  this._callbacks.clear();
  }
  async __re__emitExecutionContext({ world, targetId, frame = null }) {
    const fixMode = process.env['REBROWSER_PATCHES_RUNTIME_FIX_MODE'] || 'addBinding';
    const utilityWorldName = process.env['REBROWSER_PATCHES_UTILITY_WORLD_NAME'] !== '0'
      ? (process.env['REBROWSER_PATCHES_UTILITY_WORLD_NAME'] || 'util')
      : '__playwright_utility_world__';
    let getWorldPromise;
    if (fixMode === 'addBinding') {
      if (world === 'utility') {
        getWorldPromise = this.__re__getIsolatedWorld({ client: this, frameId: targetId, worldName: utilityWorldName })
          .then((contextId) => ({ id: contextId, name: '__playwright_utility_world__', auxData: { frameId: targetId, isDefault: false } }));
      } else if (world === 'main') {
        getWorldPromise = this.__re__getMainWorld({ client: this, frameId: targetId, isWorker: frame === null })
          .then((contextId) => ({ id: contextId, name: '', auxData: { frameId: targetId, isDefault: true } }));
      }
    } else if (fixMode === 'alwaysIsolated') {
      getWorldPromise = this.__re__getIsolatedWorld({ client: this, frameId: targetId, worldName: utilityWorldName })
        .then((contextId) => ({ id: contextId, name: '', auxData: { frameId: targetId, isDefault: true } }));
    }
    if (!getWorldPromise) {
      return;
    }
    const contextPayload = await getWorldPromise;
    this.emit('Runtime.executionContextCreated', { context: contextPayload });
  }
  async __re__getMainWorld({ client, frameId, isWorker = false }) {
    let contextId;
    const randomName = [...Array(Math.floor(Math.random() * 11) + 10)].map(() => Math.random().toString(36)[2]).join('');
    await client.send('Runtime.addBinding', { name: randomName });
    const bindingCalledHandler = ({ name, payload, executionContextId }) => {
      if (contextId > 0) return;
      if (name !== randomName) return;
      if (payload !== frameId) return;
      contextId = executionContextId;
      client.off('Runtime.bindingCalled', bindingCalledHandler);
    };
    client.on('Runtime.bindingCalled', bindingCalledHandler);
    if (isWorker) {
      await client.send('Runtime.evaluate', { expression: "this['" + randomName + "']('" + frameId + "')" });
    } else {
      await client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: "document.addEventListener('" + randomName + "', (e) => self['" + randomName + "'](e.detail.frameId))",
        runImmediately: true
      });
      const result = await client.send('Page.createIsolatedWorld', {
        frameId, worldName: randomName, grantUniveralAccess: true
      });
      await client.send('Runtime.evaluate', {
        expression: "document.dispatchEvent(new CustomEvent('" + randomName + "', { detail: { frameId: '" + frameId + "' } }))",
        contextId: result.executionContextId
      });
    }
    return contextId;
  }
  async __re__getIsolatedWorld({ client, frameId, worldName }) {
    const result = await client.send('Page.createIsolatedWorld', { frameId, worldName, grantUniveralAccess: true });
    return result.executionContextId;
  }
}
class CDPSession`;
        c = c.replace(search, replace);
        fs.writeFileSync(fp, c);
        console.log('[patch-playwright] patched crConnection.js __re__ methods');
        patched++;
      } else {
        skipped++;
      }
    } else {
      skipped++;
    }
  }
}

// 6. frames.js — _context method + executionContextsCleared on commit
{
  const fp = path.join(SERVER, 'frames.js');
  if (fs.existsSync(fp)) {
    let c = fs.readFileSync(fp, 'utf8');
    if (!c.includes('REBROWSER_PATCHES_RUNTIME_FIX_MODE') && !c.includes('__re__emitExecutionContext')) {
      let modified = false;

      // Patch _onLifecycleEvent("commit") to emit executionContextsCleared
      const commitSearch = '    this._onLifecycleEvent("commit");\n  }\n  setPendingDocument(documentInfo)';
      if (c.includes(commitSearch)) {
        c = c.replace(commitSearch, `    this._onLifecycleEvent("commit");
    try {
      if (process.env['REBROWSER_PATCHES_RUNTIME_FIX_MODE'] !== '0') {
        const crSess = (this._page.delegate._sessions && this._page.delegate._sessions.get(this._id) || this._page.delegate._mainFrameSession) && (this._page.delegate._sessions && this._page.delegate._sessions.get(this._id) || this._page.delegate._mainFrameSession)._client;
        if (crSess) crSess.emit('Runtime.executionContextsCleared');
      }
    } catch(e) {}
  }
  setPendingDocument(documentInfo)`);
        modified = true;
      }

      // Patch _context(world) to use __re__emitExecutionContext
      const ctxSearch = '  _context(world) {\n    return this._contextData.get(world).contextPromise.then((contextOrDestroyedReason) => {\n      if (contextOrDestroyedReason instanceof js.ExecutionContext)\n        return contextOrDestroyedReason;\n      throw new Error(contextOrDestroyedReason.destroyedReason);\n    });\n  }';
      if (c.includes(ctxSearch)) {
        c = c.replace(ctxSearch, `  _context(world, useContextPromise) {
    if (process.env['REBROWSER_PATCHES_RUNTIME_FIX_MODE'] === '0' || !!(this._contextData.get(world) && this._contextData.get(world).context) || useContextPromise) {
      return this._contextData.get(world).contextPromise.then(function(contextOrDestroyedReason) {
        if (contextOrDestroyedReason instanceof js.ExecutionContext)
          return contextOrDestroyedReason;
        throw new Error(contextOrDestroyedReason.destroyedReason);
      });
    }
    try {
      const sessions = this._page.delegate._sessions;
      const sess = (sessions && sessions.get(this._id)) || this._page.delegate._mainFrameSession;
      const crSess = sess && sess._client;
      if (crSess && crSess.__re__emitExecutionContext) {
        const self = this;
        return crSess.__re__emitExecutionContext({ world: world, targetId: this._id, frame: this }).then(function() {
          return self._context(world, true);
        }).catch(function(err) {
          return self._context(world, true);
        });
      }
    } catch(e) {}
    return this._contextData.get(world).contextPromise.then(function(contextOrDestroyedReason) {
      if (contextOrDestroyedReason instanceof js.ExecutionContext)
        return contextOrDestroyedReason;
      throw new Error(contextOrDestroyedReason.destroyedReason);
    });
  }`);
        modified = true;
      }

      if (modified) {
        fs.writeFileSync(fp, c);
        console.log('[patch-playwright] patched frames.js');
        patched++;
      } else {
        skipped++;
      }
    } else {
      skipped++;
    }
  }
}

if (patched > 0 || skipped > 0) {
  console.log('[patch-playwright] done: ' + patched + ' patched, ' + skipped + ' skipped');
}
