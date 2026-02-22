#!/usr/bin/env node

/**
 * anybrowse Registry Registration Script
 * 
 * This script registers your MCP server with the anybrowse registry,
 * making your tools discoverable by other agents.
 * 
 * Usage:
 *   export ANYBROWSE_API_KEY="your_api_key"
 *   npm run register
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration
const ANYBROWSE_REGISTRY_URL = process.env.ANYBROWSE_REGISTRY_URL || 'https://api.anybrowse.dev/v1';
const ANYBROWSE_API_KEY = process.env.ANYBROWSE_API_KEY;

// Load package.json for metadata
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
);

// Load tools from your server (in production, this would introspect your server)
const TOOLS_MANIFEST = {
  name: packageJson.name,
  version: packageJson.version,
  description: packageJson.description,
  tools: [
    {
      name: 'get_weather',
      description: 'Get current weather conditions for a location. Use this when you need weather data including temperature, conditions, and forecast.',
      category: 'data',
      tags: ['weather', 'location', 'forecast'],
      pricing: {
        type: 'free', // or 'per_call', 'subscription'
        amount: 0,
      },
      rateLimit: {
        requestsPerMinute: 60,
      },
    },
    {
      name: 'calculate',
      description: 'Evaluate a mathematical expression safely. Use this for any calculations, unit conversions, or numerical operations.',
      category: 'utility',
      tags: ['math', 'calculator', 'computation'],
      pricing: {
        type: 'free',
        amount: 0,
      },
      rateLimit: {
        requestsPerMinute: 100,
      },
    },
  ],
  endpoints: {
    mcp: {
      transport: 'stdio',
      command: 'node',
      args: [join(__dirname, 'index.js')],
    },
    // Optional: HTTP transport for remote access
    // http: {
    //   url: 'https://your-server.com/mcp',
    //   auth: 'bearer',
    // },
  },
  metadata: {
    author: packageJson.author || 'anonymous',
    license: packageJson.license,
    repository: packageJson.repository?.url,
    keywords: packageJson.keywords,
  },
};

async function registerWithAnybrowse() {
  if (!ANYBROWSE_API_KEY) {
    console.error('❌ Error: ANYBROWSE_API_KEY environment variable is required');
    console.error('   Get your API key at: https://anybrowse.dev/dashboard');
    console.error('   Then run: export ANYBROWSE_API_KEY="your_key"');
    process.exit(1);
  }

  console.log('🚀 Registering with anybrowse registry...');
  console.log(`   Server: ${TOOLS_MANIFEST.name}`);
  console.log(`   Tools: ${TOOLS_MANIFEST.tools.length}`);
  console.log();

  try {
    const response = await fetch(`${ANYBROWSE_REGISTRY_URL}/servers/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ANYBROWSE_API_KEY}`,
      },
      body: JSON.stringify(TOOLS_MANIFEST),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Registration failed: ${response.status} ${error}`);
    }

    const result = await response.json();

    console.log('✅ Successfully registered!');
    console.log();
    console.log('   Server ID:', result.serverId);
    console.log('   Registry URL:', `${ANYBROWSE_REGISTRY_URL}/servers/${result.serverId}`);
    console.log();
    console.log('Your tools are now discoverable by any agent on the network.');
    console.log('Share your server: https://anybrowse.dev/s/' + result.serverId);

  } catch (error) {
    console.error('❌ Registration failed:', error instanceof Error ? error.message : error);
    
    // Fallback: Save manifest locally for manual registration
    console.log();
    console.log('💾 Saving manifest to anybrowse-manifest.json for manual registration...');
    
    const { writeFileSync } = await import('fs');
    writeFileSync(
      'anybrowse-manifest.json',
      JSON.stringify(TOOLS_MANIFEST, null, 2)
    );
    
    console.log('   Upload this file at: https://anybrowse.dev/register');
    process.exit(1);
  }
}

registerWithAnybrowse();
