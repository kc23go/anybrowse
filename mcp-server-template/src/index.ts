import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/**
 * anybrowse MCP Server Template
 * 
 * This is a boilerplate for creating MCP-compatible servers that can be
 * registered with the anybrowse registry. Agents can discover and call
 * these tools via the anybrowse network.
 * 
 * Quick Start:
 * 1. Define your tools in the TOOLS array below
 * 2. Implement the handlers in the switch statement
 * 3. Run `npm run register` to publish to anybrowse
 * 4. Your tool is now discoverable by any agent
 */

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

/**
 * Define your tools here. Each tool needs:
 * - name: Unique identifier (kebab-case recommended)
 * - description: Clear explanation for AI agents
 * - inputSchema: Zod schema for validation (converted to JSON Schema)
 */

const WeatherInputSchema = z.object({
  location: z.string().describe('City name or coordinates'),
  units: z.enum(['celsius', 'fahrenheit']).default('celsius').describe('Temperature units'),
});

const CalculateInputSchema = z.object({
  expression: z.string().describe('Mathematical expression to evaluate (e.g., "2 + 2 * 5")'),
});

const TOOLS: Tool[] = [
  {
    name: 'get_weather',
    description: 'Get current weather conditions for a location. Use this when you need weather data including temperature, conditions, and forecast.',
    inputSchema: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City name or coordinates',
        },
        units: {
          type: 'string',
          enum: ['celsius', 'fahrenheit'],
          default: 'celsius',
          description: 'Temperature units',
        },
      },
      required: ['location'],
    },
  },
  {
    name: 'calculate',
    description: 'Evaluate a mathematical expression safely. Use this for any calculations, unit conversions, or numerical operations.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'Mathematical expression to evaluate (e.g., "2 + 2 * 5")',
        },
      },
      required: ['expression'],
    },
  },
  // ADD YOUR TOOLS HERE
];

// ============================================================================
// TOOL IMPLEMENTATIONS
// ============================================================================

/**
 * Implement your tool logic here. Each handler receives the validated
 * arguments and should return { content: [...] } or throw an error.
 */

async function handleGetWeather(args: unknown) {
  const { location, units } = WeatherInputSchema.parse(args);
  
  // TODO: Replace with actual weather API call
  // Example: OpenWeatherMap, WeatherAPI, etc.
  
  const mockData = {
    location,
    temperature: units === 'celsius' ? 22 : 72,
    condition: 'Sunny',
    humidity: 45,
    windSpeed: 10,
    units,
  };

  return {
    content: [
      {
        type: 'text',
        text: `Weather for ${mockData.location}:
Temperature: ${mockData.temperature}°${units === 'celsius' ? 'C' : 'F'}
Condition: ${mockData.condition}
Humidity: ${mockData.humidity}%
Wind: ${mockData.windSpeed} mph`,
      },
    ],
  };
}

async function handleCalculate(args: unknown) {
  const { expression } = CalculateInputSchema.parse(args);
  
  // Safe evaluation - only allow basic math operations
  const sanitized = expression.replace(/[^0-9+\-*/().\s]/g, '');
  
  try {
    // eslint-disable-next-line no-eval
    const result = eval(sanitized);
    
    return {
      content: [
        {
          type: 'text',
          text: `${expression} = ${result}`,
        },
      ],
    };
  } catch (error) {
    throw new Error(`Invalid expression: ${expression}`);
  }
}

// ============================================================================
// SERVER SETUP
// ============================================================================

const server = new Server(
  {
    name: 'anybrowse-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_weather':
        return await handleGetWeather(args);
      
      case 'calculate':
        return await handleCalculate(args);
      
      // ADD YOUR HANDLERS HERE
      
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('anybrowse MCP server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
