#!/usr/bin/env node
/**
 * patch-playwright.js
 * 
 * Manually applies rebrowser-patches fixes to playwright-core.
 * These patches suppress Runtime.enable CDP commands that expose automation detection.
 * 
 * Run after npm install: node scripts/patch-playwright.js
 * Or automatically via postinstall in package.json
 */

const fs = require('fs');
const path = require('path');

const PLAYWRIGHT_CORE = path.join(__dirname, '..', 'node_modules', 'playwright-core', 'lib', 'server');
const CHROMIUM = path.join(PLAYWRIGHT_CORE, 'chromium');

let patchCount = 0;
let skipCount = 0;

function patchFile(filePath, description, searchStr, replaceStr) {
  if (!fs.existsSync(filePath)) {
    console.log(`SKIP ${description} — file not found`);
    skipCount++;
    return;
  }
  let content = fs.readFileSync(filePath, 'utf8');
  if (content.includes('REBROWSER_PATCHES_RUNTIME_FIX_MODE')) {
    console.log(`SKIP ${description} — already patched`);
    skipCount++;
    return;
  }
  if (!content.includes(searchStr)) {
    console.log(`SKIP ${description} — pattern not found (version mismatch?)`);
    skipCount++;
    return;
  }
  content = content.replace(searchStr, replaceStr);
  fs.writeFileSync(filePath, content);
  console.log(`PATCH ${description} — applied`);
  patchCount++;
}

// 1. crDevTools.js — suppress Runtime.enable for DevTools inspector
patchFile(
  path.join(CHROMIUM, 'crDevTools.js'),
  'crDevTools.js Runtime.enable',
  'session.send("Runtime.enable"),',
  '(() => { if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] === "0") { return session.send("Runtime.enable"); } })(),'
);

// 2. crPage.js — suppress Runtime.enable in main page session
patchFile(
  path.join(CHROMIUM, 'crPage.js'),
  'crPage.js Runtime.enable (main)',
  'this._client.send("Runtime.enable", {}),',
  '(() => { if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] === "0") { return this._client.send("Runtime.enable", {}); } })(),'
);

// 3. crPage.js — suppress Runtime.enable for workers
patchFile(
  path.join(CHROMIUM, 'crPage.js'),
  'crPage.js Runtime.enable (worker)',
  'session._sendMayFail("Runtime.enable");',
  'if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] === "0") { session._sendMayFail("Runtime.enable"); }'
);

// 4. crServiceWorker.js — suppress Runtime.enable for service workers  
patchFile(
  path.join(CHROMIUM, 'crServiceWorker.js'),
  'crServiceWorker.js Runtime.enable',
  'session.send("Runtime.enable", {}).catch((e) => {\n    });',
  'if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] === "0") { session.send("Runtime.enable", {}).catch((e) => {}); }'
);

// 5. crConnection.js — add __re__ helper methods for context acquisition
{
  const filePath = path.join(CHROMIUM, 'crConnection.js');
  const description = 'crConnection.js __re__ methods';
  if (!fs.existsSync(filePath)) {
    console.log(`SKIP ${description} — file not found`);
    skipCount++;
  } else {
    let content = fs.readFileSync(filePath, 'utf8');
    if (content.includes('__re__emitExecutionContext')) {
      console.log(`SKIP ${description} — already patched`);
      skipCount++;
    } else {
      const searchStr = '  this._callbacks.clear();\n  }\n}\nclass CDPSession';
      const replaceStr = `  this._callbacks.clear();
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
      await client.send('Runtime.evaluate', { expression: \`this['\${randomName}']('\${frameId}')\` });
    } else {
      await client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: \`document.addEventListener('\${randomName}', (e) => self['\${randomName}'](e.detail.frameId))\`,
        runImmediately: true
      });
      const result = await client.send('Page.createIsolatedWorld', {
        frameId, worldName: randomName, grantUniveralAccess: true
      });
      await client.send('Runtime.evaluate', {
        expression: \`document.dispatchEvent(new CustomEvent('\${randomName}', { detail: { frameId: '\${frameId}' } }))\`,
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
      if (content.includes(searchStr)) {
        content = content.replace(searchStr, replaceStr);
        fs.writeFileSync(filePath, content);
        console.log(`PATCH ${description} — applied`);
        patchCount++;
      } else {
        console.log(`SKIP ${description} — search pattern not found`);
        skipCount++;
      }
    }
  }
}

console.log(`\nrebrowser-patches: ${patchCount} applied, ${skipCount} skipped`);
