#!/usr/bin/env node
/**
 * patch-playwright.cjs (CommonJS — runs as postinstall)
 *
 * Applies rebrowser-patches-style Runtime.enable suppression to playwright-core.
 * Must run BEFORE the app starts (via postinstall) so patches are in effect when modules load.
 *
 * Run: node src/patch-playwright.cjs
 * Automatic: "postinstall": "node src/patch-playwright.cjs" in package.json
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

// 3. crPage.js (worker session)
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
        const replace = '  this._callbacks.clear();\n' +
          '  }\n' +
          '  async __re__emitExecutionContext({ world, targetId, frame = null }) {\n' +
          '    const fixMode = process.env[\'REBROWSER_PATCHES_RUNTIME_FIX_MODE\'] || \'addBinding\';\n' +
          '    const utilityWorldName = process.env[\'REBROWSER_PATCHES_UTILITY_WORLD_NAME\'] !== \'0\'\n' +
          '      ? (process.env[\'REBROWSER_PATCHES_UTILITY_WORLD_NAME\'] || \'util\')\n' +
          '      : \'__playwright_utility_world__\';\n' +
          '    let getWorldPromise;\n' +
          '    if (fixMode === \'addBinding\') {\n' +
          '      if (world === \'utility\') {\n' +
          '        getWorldPromise = this.__re__getIsolatedWorld({ client: this, frameId: targetId, worldName: utilityWorldName })\n' +
          '          .then((contextId) => ({ id: contextId, name: \'__playwright_utility_world__\', auxData: { frameId: targetId, isDefault: false } }));\n' +
          '      } else if (world === \'main\') {\n' +
          '        getWorldPromise = this.__re__getMainWorld({ client: this, frameId: targetId, isWorker: frame === null })\n' +
          '          .then((contextId) => ({ id: contextId, name: \'\', auxData: { frameId: targetId, isDefault: true } }));\n' +
          '      }\n' +
          '    } else if (fixMode === \'alwaysIsolated\') {\n' +
          '      getWorldPromise = this.__re__getIsolatedWorld({ client: this, frameId: targetId, worldName: utilityWorldName })\n' +
          '        .then((contextId) => ({ id: contextId, name: \'\', auxData: { frameId: targetId, isDefault: true } }));\n' +
          '    }\n' +
          '    if (!getWorldPromise) return;\n' +
          '    const contextPayload = await getWorldPromise;\n' +
          '    this.emit(\'Runtime.executionContextCreated\', { context: contextPayload });\n' +
          '  }\n' +
          '  async __re__getMainWorld({ client, frameId, isWorker = false }) {\n' +
          '    let contextId;\n' +
          '    const randomName = [...Array(Math.floor(Math.random() * 11) + 10)].map(() => Math.random().toString(36)[2]).join(\'\');\n' +
          '    await client.send(\'Runtime.addBinding\', { name: randomName });\n' +
          '    const bindingCalledHandler = ({ name, payload, executionContextId }) => {\n' +
          '      if (contextId > 0) return;\n' +
          '      if (name !== randomName) return;\n' +
          '      if (payload !== frameId) return;\n' +
          '      contextId = executionContextId;\n' +
          '      client.off(\'Runtime.bindingCalled\', bindingCalledHandler);\n' +
          '    };\n' +
          '    client.on(\'Runtime.bindingCalled\', bindingCalledHandler);\n' +
          '    if (isWorker) {\n' +
          '      await client.send(\'Runtime.evaluate\', { expression: "this[\'" + randomName + "\'](\'" + frameId + "\')" });\n' +
          '    } else {\n' +
          '      await client.send(\'Page.addScriptToEvaluateOnNewDocument\', {\n' +
          '        source: "document.addEventListener(\'" + randomName + "\', (e) => self[\'" + randomName + "\'](e.detail.frameId))",\n' +
          '        runImmediately: true\n' +
          '      });\n' +
          '      const result = await client.send(\'Page.createIsolatedWorld\', {\n' +
          '        frameId, worldName: randomName, grantUniveralAccess: true\n' +
          '      });\n' +
          '      await client.send(\'Runtime.evaluate\', {\n' +
          '        expression: "document.dispatchEvent(new CustomEvent(\'" + randomName + "\', { detail: { frameId: \'" + frameId + "\' } }))",\n' +
          '        contextId: result.executionContextId\n' +
          '      });\n' +
          '    }\n' +
          '    return contextId;\n' +
          '  }\n' +
          '  async __re__getIsolatedWorld({ client, frameId, worldName }) {\n' +
          '    const result = await client.send(\'Page.createIsolatedWorld\', { frameId, worldName, grantUniveralAccess: true });\n' +
          '    return result.executionContextId;\n' +
          '  }\n' +
          '}\n' +
          'class CDPSession';
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
        c = c.replace(commitSearch,
          '    this._onLifecycleEvent("commit");\n' +
          '    try {\n' +
          '      if (process.env[\'REBROWSER_PATCHES_RUNTIME_FIX_MODE\'] !== \'0\') {\n' +
          '        const _sess = this._page.delegate._sessions && this._page.delegate._sessions.get(this._id);\n' +
          '        const crSess = (_sess || this._page.delegate._mainFrameSession);\n' +
          '        if (crSess && crSess._client) crSess._client.emit(\'Runtime.executionContextsCleared\');\n' +
          '      }\n' +
          '    } catch(e) {}\n' +
          '  }\n' +
          '  setPendingDocument(documentInfo)'
        );
        modified = true;
      }

      // Patch _context(world) to use __re__emitExecutionContext
      const ctxSearch = '  _context(world) {\n    return this._contextData.get(world).contextPromise.then((contextOrDestroyedReason) => {\n      if (contextOrDestroyedReason instanceof js.ExecutionContext)\n        return contextOrDestroyedReason;\n      throw new Error(contextOrDestroyedReason.destroyedReason);\n    });\n  }';
      if (c.includes(ctxSearch)) {
        c = c.replace(ctxSearch,
          '  _context(world, useContextPromise) {\n' +
          '    var ctxData = this._contextData.get(world);\n' +
          '    if (process.env[\'REBROWSER_PATCHES_RUNTIME_FIX_MODE\'] === \'0\' || (ctxData && ctxData.context) || useContextPromise) {\n' +
          '      return ctxData.contextPromise.then(function(r) {\n' +
          '        if (r instanceof js.ExecutionContext) return r;\n' +
          '        throw new Error(r.destroyedReason);\n' +
          '      });\n' +
          '    }\n' +
          '    try {\n' +
          '      var _sess = this._page.delegate._sessions && this._page.delegate._sessions.get(this._id);\n' +
          '      var sess = _sess || this._page.delegate._mainFrameSession;\n' +
          '      var crSess = sess && sess._client;\n' +
          '      if (crSess && crSess.__re__emitExecutionContext) {\n' +
          '        var self = this;\n' +
          '        return crSess.__re__emitExecutionContext({ world: world, targetId: this._id, frame: this })\n' +
          '          .then(function() { return self._context(world, true); })\n' +
          '          .catch(function() { return self._context(world, true); });\n' +
          '      }\n' +
          '    } catch(e) {}\n' +
          '    return ctxData.contextPromise.then(function(r) {\n' +
          '      if (r instanceof js.ExecutionContext) return r;\n' +
          '      throw new Error(r.destroyedReason);\n' +
          '    });\n' +
          '  }'
        );
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

console.log('[patch-playwright] done: ' + patched + ' patched, ' + skipped + ' skipped (already patched or version mismatch)');
