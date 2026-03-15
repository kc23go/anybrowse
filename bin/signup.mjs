#!/usr/bin/env node
/**
 * anybrowse signup CLI
 * Usage: npx anybrowse signup
 */

import { createInterface } from 'readline';
import https from 'https';

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(q) {
  return new Promise(resolve => rl.question(q, resolve));
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { reject(new Error('Bad response: ' + raw)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

console.log('\n🌐 anybrowse — Get your free API key\n');
console.log('50 scrapes/day, no credit card needed.\n');

const email = await ask('Enter your email: ');
if (!email || !email.includes('@')) {
  console.error('❌ Please enter a valid email address.');
  process.exit(1);
}

console.log('\nGenerating your key...');

try {
  const res = await postJson('https://anybrowse.dev/api/signup', { email });
  if (!res.key) throw new Error(res.error || 'No key returned');

  const key = res.key;
  const isExisting = res.existing;

  console.log(isExisting ? '\n✓ Found your existing key:' : '\n✓ Your API key is ready:');
  console.log('\n  ' + key + '\n');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Add to your MCP config (claude_desktop_config.json or .cursor/mcp.json):');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(JSON.stringify({
    mcpServers: {
      anybrowse: {
        type: "streamable-http",
        url: "https://anybrowse.dev/mcp",
        headers: { Authorization: `Bearer ${key}` }
      }
    }
  }, null, 2));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('Done! Restart your AI editor and you\'re ready to go.\n');
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exit(1);
}

rl.close();
