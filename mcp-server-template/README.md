# anybrowse MCP Server Template

Boilerplate for creating MCP-compatible servers that can be registered with the anybrowse registry.

## Quick Start

```bash
# 1. Use this template
git clone https://github.com/anybrowse/mcp-server-template.git my-mcp-server
cd my-mcp-server

# 2. Install dependencies
npm install

# 3. Build
npm run build

# 4. Define your tools in src/index.ts

# 5. Register with anybrowse
export ANYBROWSE_API_KEY="your_api_key"
npm run register
```

## What is MCP?

The Model Context Protocol (MCP) is an open protocol that standardizes how applications provide context to LLMs. Think of it like a USB-C port for AI applications—unified interface for connecting AI systems to data sources and tools.

## Project Structure

```
my-mcp-server/
├── src/
│   ├── index.ts          # Main server with tool definitions
│   └── register.ts       # Registration script for anybrowse
├── dist/                 # Compiled JavaScript
├── package.json
├── tsconfig.json
└── README.md
```

## Adding Your Own Tools

### 1. Define the Tool Schema

In `src/index.ts`, add your tool to the `TOOLS` array:

```typescript
const TOOLS: Tool[] = [
  // ... existing tools
  {
    name: 'my_custom_tool',
    description: 'Clear description that helps AI agents understand when to use this tool. Be specific about use cases.',
    inputSchema: {
      type: 'object',
      properties: {
        param1: {
          type: 'string',
          description: 'What this parameter does',
        },
        param2: {
          type: 'number',
          description: 'Another parameter',
        },
      },
      required: ['param1'],
    },
  },
];
```

### 2. Implement the Handler

Add your implementation in the switch statement:

```typescript
import { z } from 'zod';

// Define schema for type safety
const MyToolSchema = z.object({
  param1: z.string(),
  param2: z.number().optional(),
});

async function handleMyCustomTool(args: unknown) {
  const { param1, param2 } = MyToolSchema.parse(args);
  
  // Your implementation here
  const result = await doSomething(param1, param2);
  
  return {
    content: [
      {
        type: 'text',
        text: `Result: ${result}`,
      },
    ],
  };
}

// Add to switch statement
case 'my_custom_tool':
  return await handleMyCustomTool(args);
```

### 3. Update Registration Manifest

In `src/register.ts`, add your tool to the `TOOLS_MANIFEST`:

```typescript
tools: [
  // ... existing tools
  {
    name: 'my_custom_tool',
    description: '...',
    category: 'utility', // or 'data', 'ai', 'integration', etc.
    tags: ['tag1', 'tag2'],
    pricing: {
      type: 'free', // or 'per_call', 'subscription'
      amount: 0,
    },
  },
],
```

## Tool Best Practices

### 1. Clear Descriptions
Your tool description is how AI agents decide to use it. Be specific:

```typescript
// ❌ Bad
description: 'Gets data'

// ✅ Good
description: 'Retrieves current stock price and market data for a given ticker symbol. Use this when the user asks about stock prices, market cap, or trading volume.'
```

### 2. Input Validation
Always validate inputs using Zod schemas:

```typescript
const MySchema = z.object({
  email: z.string().email(),
  count: z.number().int().positive().max(100),
});
```

### 3. Error Handling
Return helpful error messages:

```typescript
try {
  const result = await apiCall();
  return { content: [{ type: 'text', text: result }] };
} catch (error) {
  return {
    content: [{ type: 'text', text: `API Error: ${error.message}` }],
    isError: true,
  };
}
```

### 4. Rate Limiting
Be respectful of external APIs. Implement rate limiting in your handlers.

## Registration

### Get API Key
1. Sign up at https://anybrowse.dev
2. Create a new project
3. Copy your API key

### Register Your Server

```bash
export ANYBROWSE_API_KEY="your_key_here"
npm run register
```

Your server is now discoverable by any agent on the anybrowse network!

### Manual Registration

If automatic registration fails, the script saves a `anybrowse-manifest.json` file. Upload this manually at https://anybrowse.dev/register

## Testing

Test your server locally:

```bash
# Build first
npm run build

# Run the server
npm start
```

The server communicates via stdio (standard input/output). In production, anybrowse handles the transport layer.

## Deployment Options

### Option 1: Self-Hosted (Default)
Your server runs on your infrastructure. Agents connect via anybrowse's routing layer.

### Option 2: anybrowse Hosted
Deploy to anybrowse's managed infrastructure (coming soon):

```bash
npm run deploy
```

### Option 3: HTTP Transport
For remote access, implement HTTP transport:

```typescript
// src/http-server.ts
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

const app = express();
const server = new Server({ name: 'my-server', version: '1.0.0' }, { capabilities: { tools: {} } });

// ... setup handlers ...

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  // Handle messages
});

app.listen(3000);
```

Update your manifest:

```typescript
endpoints: {
  http: {
    url: 'https://your-server.com/sse',
    auth: 'bearer',
  },
}
```

## Examples

See `examples/` directory for:
- `weather-server/` - Complete weather API integration
- `calculator-server/` - Math utilities
- `database-server/` - SQL query interface
- `slack-server/` - Slack bot integration

## Resources

- [MCP Documentation](https://modelcontextprotocol.io/)
- [anybrowse Documentation](https://docs.anybrowse.dev)
- [Discord Community](https://discord.gg/anybrowse)

## License

MIT
