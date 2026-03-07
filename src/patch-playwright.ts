/**
 * patch-playwright.ts
 *
 * Applies rebrowser-patches-style fixes to playwright-core at runtime.
 * Suppresses Runtime.enable CDP commands that expose browser automation.
 * Called from pool.ts before playwright is used.
 *
 * These patches match the rebrowser-patches project v1.0.x for playwright-core 1.x.
 * Reference: https://github.com/rebrowser/rebrowser-patches
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findPlaywrightCorePath(): string | null {
  // Try to resolve from this file's location
  const candidates = [
    join(__dirname, '..', 'node_modules', 'playwright-core'),
    join(__dirname, '..', '..', 'node_modules', 'playwright-core'),
    join(__dirname, '..', '..', '..', 'node_modules', 'playwright-core'),
  ];
  for (const p of candidates) {
    if (existsSync(join(p, 'package.json'))) return p;
  }
  try {
    return dirname(dirname(require.resolve('playwright-core/package.json')));
  } catch {
    return null;
  }
}

interface PatchSpec {
  description: string;
  file: string;
  search: string;
  replace: string;
}

function applyPatch(basePath: string, spec: PatchSpec): boolean {
  const filePath = join(basePath, spec.file);
  if (!existsSync(filePath)) {
    console.log(`[playwright-patch] SKIP ${spec.description} — file not found`);
    return false;
  }
  let content = readFileSync(filePath, 'utf8');
  if (content.includes('REBROWSER_PATCHES_RUNTIME_FIX_MODE') || content.includes('__re__emitExecutionContext')) {
    // Already patched
    return false;
  }
  if (!content.includes(spec.search)) {
    console.log(`[playwright-patch] SKIP ${spec.description} — pattern not found (version mismatch?)`);
    return false;
  }
  content = content.replace(spec.search, spec.replace);
  writeFileSync(filePath, content);
  console.log(`[playwright-patch] PATCH ${spec.description} — applied`);
  return true;
}

export function applyPlaywrightPatches(): void {
  const basePath = findPlaywrightCorePath();
  if (!basePath) {
    console.warn('[playwright-patch] playwright-core not found, skipping patches');
    return;
  }

  const chromiumBase = 'lib/server/chromium';
  const serverBase = 'lib/server';
  let patchCount = 0;

  const patches: PatchSpec[] = [
    {
      description: 'crDevTools.js Runtime.enable',
      file: `${chromiumBase}/crDevTools.js`,
      search: 'session.send("Runtime.enable"),',
      replace: '(() => { if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] === "0") { return session.send("Runtime.enable"); } })(),',
    },
    {
      description: 'crPage.js Runtime.enable (main)',
      file: `${chromiumBase}/crPage.js`,
      search: 'this._client.send("Runtime.enable", {}),',
      replace: '(() => { if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] === "0") { return this._client.send("Runtime.enable", {}); } })(),',
    },
    {
      description: 'crPage.js Runtime.enable (worker)',
      file: `${chromiumBase}/crPage.js`,
      search: 'session._sendMayFail("Runtime.enable");',
      replace: 'if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] === "0") { session._sendMayFail("Runtime.enable"); }',
    },
    {
      description: 'crServiceWorker.js Runtime.enable',
      file: `${chromiumBase}/crServiceWorker.js`,
      search: 'session.send("Runtime.enable", {}).catch((e) => {\n    });',
      replace: 'if (process.env["REBROWSER_PATCHES_RUNTIME_FIX_MODE"] === "0") { session.send("Runtime.enable", {}).catch((e) => {}); }',
    },
  ];

  for (const patch of patches) {
    if (applyPatch(basePath, patch)) patchCount++;
  }

  // crConnection.js — add __re__ methods for execution context without Runtime.enable
  {
    const filePath = join(basePath, `${chromiumBase}/crConnection.js`);
    if (existsSync(filePath)) {
      let content = readFileSync(filePath, 'utf8');
      if (!content.includes('__re__emitExecutionContext')) {
        const searchStr = '  this._callbacks.clear();\n  }\n}\nclass CDPSession';
        if (content.includes(searchStr)) {
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
          content = content.replace(searchStr, replaceStr);
          writeFileSync(filePath, content);
          console.log(`[playwright-patch] PATCH crConnection.js __re__ methods — applied`);
          patchCount++;
        } else {
          console.log(`[playwright-patch] SKIP crConnection.js — search pattern not found`);
        }
      }
    }
  }

  // frames.js — emit executionContextsCleared on commit + patch _context method
  {
    const filePath = join(basePath, `${serverBase}/frames.js`);
    if (existsSync(filePath)) {
      let content = readFileSync(filePath, 'utf8');
      let modified = false;

      // Patch 1: emit executionContextsCleared after lifecycle commit
      if (!content.includes('REBROWSER_PATCHES_RUNTIME_FIX_MODE') && content.includes('_onLifecycleEvent("commit");')) {
        const search = '    this._onLifecycleEvent("commit");\n  }\n  setPendingDocument(documentInfo)';
        if (content.includes(search)) {
          const replace = `    this._onLifecycleEvent("commit");
    try {
      if (process.env['REBROWSER_PATCHES_RUNTIME_FIX_MODE'] !== '0') {
        const crSess = (this._page.delegate._sessions?.get(this._id) || this._page.delegate._mainFrameSession)?._client;
        if (crSess) crSess.emit('Runtime.executionContextsCleared');
      }
    } catch(e) {}
  }
  setPendingDocument(documentInfo)`;
          content = content.replace(search, replace);
          modified = true;
        }
      }

      // Patch 2: patch _context to use __re__emitExecutionContext
      const contextSearch = '  _context(world) {\n    return this._contextData.get(world).contextPromise.then((contextOrDestroyedReason) => {\n      if (contextOrDestroyedReason instanceof js.ExecutionContext)\n        return contextOrDestroyedReason;\n      throw new Error(contextOrDestroyedReason.destroyedReason);\n    });\n  }';
      if (content.includes(contextSearch)) {
        const contextReplace = `  _context(world, useContextPromise = false) {
    if (process.env['REBROWSER_PATCHES_RUNTIME_FIX_MODE'] === '0' || this._contextData.get(world).context || useContextPromise) {
      return this._contextData.get(world).contextPromise.then((contextOrDestroyedReason) => {
        if (contextOrDestroyedReason instanceof js.ExecutionContext)
          return contextOrDestroyedReason;
        throw new Error(contextOrDestroyedReason.destroyedReason);
      });
    }
    try {
      const crSess = (this._page.delegate._sessions?.get(this._id) || this._page.delegate._mainFrameSession)?._client;
      if (crSess && crSess.__re__emitExecutionContext) {
        return crSess.__re__emitExecutionContext({ world, targetId: this._id, frame: this }).then(() => {
          return this._context(world, true);
        }).catch(() => this._context(world, true));
      }
    } catch(e) {}
    return this._contextData.get(world).contextPromise.then((contextOrDestroyedReason) => {
      if (contextOrDestroyedReason instanceof js.ExecutionContext)
        return contextOrDestroyedReason;
      throw new Error(contextOrDestroyedReason.destroyedReason);
    });
  }`;
        content = content.replace(contextSearch, contextReplace);
        modified = true;
      }

      if (modified) {
        writeFileSync(filePath, content);
        console.log(`[playwright-patch] PATCH frames.js — applied`);
        patchCount++;
      }
    }
  }

  if (patchCount > 0) {
    console.log(`[playwright-patch] Applied ${patchCount} patches to playwright-core (Runtime.enable CDP leak suppressed)`);
  } else {
    console.log(`[playwright-patch] All patches already applied or not applicable`);
  }
}

// Run directly when called as main module (e.g., `node dist/patch-playwright.js`)
const isMain = process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].split('/').pop() || '');
if (isMain) {
  applyPlaywrightPatches();
}
