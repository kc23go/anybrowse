import { Registry, Agent, createTool, z } from '../src/index.js';

/**
 * Example: Weather Agent with anybrowse TypeScript SDK
 * 
 * Shows how to:
 * 1. Define a weather tool with Zod validation
 * 2. Register it with anybrowse
 * 3. Discover and use it from another agent
 */

// ============================================================================
// PART 1: Define a Weather Tool
// ============================================================================

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get current weather conditions for a location. Use this when you need weather data including temperature, conditions, and forecast.',
  schema: {
    location: z.string().describe('City name or coordinates'),
    units: z.enum(['celsius', 'fahrenheit']).default('celsius').describe('Temperature units'),
  },
  handler: async ({ location, units }) => {
    // Mock weather API - replace with real API call
    const mockData: Record<string, { temp: number; condition: string }> = {
      'San Francisco': { temp: 18, condition: 'Foggy' },
      'New York': { temp: 25, condition: 'Sunny' },
      'London': { temp: 15, condition: 'Rainy' },
    };

    const data = mockData[location] || { temp: 20, condition: 'Clear' };
    
    let temperature = data.temp;
    if (units === 'fahrenheit') {
      temperature = temperature * 9/5 + 32;
    }

    return {
      location,
      temperature,
      units,
      condition: data.condition,
    };
  },
});

// ============================================================================
// PART 2: Temperature Conversion Tool
// ============================================================================

const convertTool = createTool({
  name: 'convert_temperature',
  description: 'Convert temperature between celsius and fahrenheit',
  schema: {
    temperature: z.number(),
    fromUnit: z.enum(['celsius', 'fahrenheit']),
    toUnit: z.enum(['celsius', 'fahrenheit']),
  },
  handler: async ({ temperature, fromUnit, toUnit }) => {
    if (fromUnit === toUnit) {
      return { temperature, unit: toUnit };
    }

    let converted: number;
    if (fromUnit === 'celsius' && toUnit === 'fahrenheit') {
      converted = temperature * 9/5 + 32;
    } else {
      converted = (temperature - 32) * 5/9;
    }

    return { temperature: converted, unit: toUnit };
  },
});

// ============================================================================
// PART 3: Register with anybrowse
// ============================================================================

async function registerWeatherServer(): Promise<string | undefined> {
  const apiKey = process.env.ANYBROWSE_API_KEY;
  if (!apiKey) {
    console.log('Set ANYBROWSE_API_KEY to register');
    return;
  }

  const registry = new Registry({ apiKey });

  const serverId = await registry.registerServer(
    'weather-provider',
    [weatherTool, convertTool],
    'Provides current weather data and temperature conversions',
    { author: 'Your Name', license: 'MIT' }
  );

  console.log(`✅ Weather server registered: ${serverId}`);
  return serverId;
}

// ============================================================================
// PART 4: Discover and Use Tools
// ============================================================================

async function discoverAndUse(): Promise<void> {
  const registry = new Registry();

  console.log('🔍 Discovering weather tools...');
  const tools = await registry.discover('weather data', { limit: 5 });

  if (tools.length === 0) {
    console.log('No weather tools found');
    return;
  }

  console.log(`Found ${tools.length} weather tools:`);
  for (const tool of tools) {
    console.log(`  - ${tool.name}: ${tool.description}`);
  }

  // Use the first tool
  const weatherTool = tools[0];
  console.log(`\n🌤️ Using ${weatherTool.name}...`);

  try {
    const result = await weatherTool.call({
      location: 'San Francisco',
      units: 'celsius',
    });
    console.log('Result:', result);
  } catch (error) {
    console.error('Error calling tool:', error);
  }
}

// ============================================================================
// PART 5: Agent Interface
// ============================================================================

async function useAgentInterface(): Promise<void> {
  const registry = new Registry();
  const agent = new Agent(registry);

  console.log('🤖 Agent finding and using weather tool...');

  try {
    const result = await agent.useTool('get weather for San Francisco', {
      location: 'San Francisco',
      units: 'celsius',
    });
    console.log('Weather:', result);
  } catch (error) {
    console.error('Error:', error);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('anybrowse SDK Example: Weather Agent (TypeScript)');
  console.log('='.repeat(60));

  // Example 1: Local tool usage
  console.log('\n1️⃣ Local tool usage:');
  const result = await weatherTool.call({ location: 'San Francisco', units: 'celsius' });
  console.log(`   Weather in SF: ${result.temperature}°C, ${result.condition}`);

  // Example 2: Temperature conversion
  console.log('\n2️⃣ Temperature conversion:');
  const converted = await convertTool.call({ temperature: 20, fromUnit: 'celsius', toUnit: 'fahrenheit' });
  console.log(`   20°C = ${converted.temperature}°F`);

  // Example 3: Registration
  console.log('\n3️⃣ Registration (requires ANYBROWSE_API_KEY):');
  await registerWeatherServer();

  // Example 4: Discovery
  console.log('\n4️⃣ Discovery (requires registered servers):');
  try {
    await discoverAndUse();
  } catch (e) {
    console.log('   (Skipped - no API key or registered servers)');
  }

  console.log('\n' + '='.repeat(60));
  console.log('Example complete!');
  console.log('='.repeat(60));
}

main().catch(console.error);
