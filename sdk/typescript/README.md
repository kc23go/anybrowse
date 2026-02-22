# @anybrowse/sdk

Official TypeScript SDK for interacting with the anybrowse agent-to-agent registry.

## Installation

```bash
npm install @anybrowse/sdk
```

## Quick Start

### Discover Tools

```typescript
import { Registry } from '@anybrowse/sdk';

// Initialize registry client
const registry = new Registry({ apiKey: 'your_api_key' });

// Discover tools by natural language query
const tools = await registry.discover('I need to get weather data');

for (const tool of tools) {
  console.log(`Found: ${tool.name} - ${tool.description}`);
}
```

### Register Your Tools

```typescript
import { Registry, createTool, z } from '@anybrowse/sdk';

// Define a tool with Zod schema
const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get current weather for a location',
  schema: {
    location: z.string(),
    units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  },
  handler: async ({ location, units }) => {
    // Your implementation
    return { temperature: 72, condition: 'sunny' };
  },
});

// Register with anybrowse
const registry = new Registry({ apiKey: 'your_api_key' });
const serverId = await registry.registerServer(
  'my-weather-server',
  [weatherTool],
  'Weather data provider'
);

console.log(`Server registered: ${serverId}`);
```

### Use the Agent Interface

```typescript
import { Registry, Agent } from '@anybrowse/sdk';

const agent = new Agent(new Registry({ apiKey: '...' }));

// The agent discovers and calls the right tool
const result = await agent.useTool('get weather for San Francisco', {
  location: 'San Francisco',
  units: 'celsius',
});

console.log(result);
```

## API Reference

### Registry

The main client for interacting with the anybrowse registry.

#### `new Registry(config?)`

Initialize the registry client.

```typescript
const registry = new Registry({
  apiKey: 'your_key',  // or set ANYBROWSE_API_KEY env var
  baseUrl: 'https://api.anybrowse.dev/v1',  // optional
});
```

#### `registry.discover(query, options?)`

Find tools matching a natural language query.

```typescript
const tools = await registry.discover('weather data', {
  category: 'data',
  tags: ['forecast'],
  limit: 5,
});
```

#### `registry.registerServer(name, tools, description?, metadata?)`

Register your server and tools with the registry.

```typescript
const serverId = await registry.registerServer(
  'my-server',
  [tool1, tool2],
  'Description',
  { author: 'Your Name' }
);
```

#### `registry.callTool(serverId, toolName, args)`

Call a remote tool.

```typescript
const result = await registry.callTool('server-123', 'get_weather', {
  location: 'NYC',
});
```

### createTool

Helper function for creating typed tools with Zod validation.

```typescript
import { createTool, z } from '@anybrowse/sdk';

const myTool = createTool({
  name: 'my_tool',
  description: 'What this tool does',
  schema: {
    param1: z.string(),
    param2: z.number().optional(),
  },
  handler: async ({ param1, param2 }) => {
    // Implementation
    return { result: 'success' };
  },
});
```

### Agent

High-level interface for automatic tool discovery and usage.

```typescript
const agent = new Agent(registry);
const result = await agent.useTool('intent description', args);
```

## Examples

See the `examples/` directory for:
- `weather-agent.ts` - Complete weather tool example
- `calculator-server.ts` - Math utilities
- `multi-tool-agent.ts` - Agent using multiple tools

## Environment Variables

- `ANYBROWSE_API_KEY`: Your API key
- `ANYBROWSE_BASE_URL`: Override default API endpoint

## License

MIT
