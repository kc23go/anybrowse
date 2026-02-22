/**
 * anybrowse TypeScript SDK
 * 
 * Install: npm install @anybrowse/sdk
 * 
 * This SDK provides a simple interface for agents to:
 * 1. Register their capabilities with the anybrowse registry
 * 2. Discover tools from other agents
 * 3. Call discovered tools
 */

import { z, ZodSchema, ZodTypeAny } from 'zod';

// ============================================================================
// TYPES
// ============================================================================

export interface ToolSchema {
  [key: string]: ZodTypeAny;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  category?: string;
  tags?: string[];
}

export interface Tool<T = Record<string, unknown>> {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler?: (args: T) => Promise<unknown> | unknown;
  serverId?: string;
  call(args: T): Promise<unknown>;
}

export interface Server {
  id: string;
  name: string;
  description: string;
  tools: Tool[];
  metadata?: Record<string, unknown>;
}

export interface RegistryConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface DiscoverOptions {
  category?: string;
  tags?: string[];
  limit?: number;
}

// ============================================================================
// REGISTRY CLIENT
// ============================================================================

export class Registry {
  private apiKey: string | undefined;
  private baseUrl: string;

  constructor(config: RegistryConfig = {}) {
    this.apiKey = config.apiKey || process.env.ANYBROWSE_API_KEY;
    this.baseUrl = config.baseUrl || 'https://api.anybrowse.dev/v1';
  }

  /**
   * Discover tools matching a natural language query
   */
  async discover(query: string, options: DiscoverOptions = {}): Promise<Tool[]> {
    const params = new URLSearchParams({
      q: query,
      limit: String(options.limit || 10),
    });

    if (options.category) {
      params.set('category', options.category);
    }
    if (options.tags) {
      params.set('tags', options.tags.join(','));
    }

    const response = await fetch(`${this.baseUrl}/tools/discover?${params}`);
    
    if (!response.ok) {
      throw new Error(`Discovery failed: ${response.status}`);
    }

    const data = await response.json();
    
    return (data.tools || []).map((item: any) => ({
      name: item.name,
      description: item.description,
      schema: item.schema || {},
      serverId: item.server_id,
      call: async (args: Record<string, unknown>) => {
        if (this.handler) {
          return this.handler(args);
        }
        if (item.server_id) {
          return this.callTool(item.server_id, item.name, args);
        }
        throw new Error('Tool has no handler or server_id');
      },
    }));
  }

  /**
   * Register a server and its tools with the registry
   */
  async registerServer(
    name: string,
    tools: Tool[],
    description: string = '',
    metadata: Record<string, unknown> = {}
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error('API key required. Set ANYBROWSE_API_KEY or pass to constructor.');
    }

    const manifest = {
      name,
      description,
      tools: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        schema: tool.schema,
      })),
      metadata,
    };

    const response = await fetch(`${this.baseUrl}/servers/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(manifest),
    });

    if (!response.ok) {
      throw new Error(`Registration failed: ${response.status}`);
    }

    const result = await response.json();
    const serverId = result.server_id;

    // Update tools with serverId
    tools.forEach(tool => {
      tool.serverId = serverId;
    });

    return serverId;
  }

  /**
   * Call a remote tool
   */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const response = await fetch(
      `${this.baseUrl}/servers/${serverId}/tools/${toolName}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }),
        },
        body: JSON.stringify({ arguments: args }),
      }
    );

    if (!response.ok) {
      throw new Error(`Tool call failed: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get details about a specific server
   */
  async getServer(serverId: string): Promise<Server> {
    const response = await fetch(`${this.baseUrl}/servers/${serverId}`);
    
    if (!response.ok) {
      throw new Error(`Failed to get server: ${response.status}`);
    }

    const data = await response.json();
    
    return {
      id: data.id,
      name: data.name,
      description: data.description || '',
      tools: (data.tools || []).map((t: any) => ({
        name: t.name,
        description: t.description,
        schema: t.schema || {},
        serverId: data.id,
        call: (args: Record<string, unknown>) => this.callTool(data.id, t.name, args),
      })),
      metadata: data.metadata || {},
    };
  }

  /**
   * List available tool categories
   */
  async listCategories(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/categories`);
    
    if (!response.ok) {
      throw new Error(`Failed to list categories: ${response.status}`);
    }

    const data = await response.json();
    return data.categories || [];
  }
}

// ============================================================================
// AGENT INTERFACE
// ============================================================================

export class Agent {
  private registry: Registry;
  private toolCache: Map<string, Tool> = new Map();

  constructor(registry: Registry) {
    this.registry = registry;
  }

  /**
   * Discover and use a tool based on intent
   */
  async useTool(intent: string, args: Record<string, unknown> = {}): Promise<unknown> {
    // Check cache first
    const cached = this.toolCache.get(intent);
    if (cached) {
      if (cached.handler) {
        return cached.handler(args);
      }
      if (cached.serverId) {
        return this.registry.callTool(cached.serverId, cached.name, args);
      }
    }

    // Discover matching tools
    const tools = await this.registry.discover(intent, { limit: 3 });

    if (tools.length === 0) {
      throw new Error(`No tools found for intent: ${intent}`);
    }

    // Use the best match
    const tool = tools[0];
    this.toolCache.set(intent, tool);

    if (tool.serverId) {
      return this.registry.callTool(tool.serverId, tool.name, args);
    }

    throw new Error(`Tool ${tool.name} has no server_id`);
  }

  /**
   * Clear the tool discovery cache
   */
  clearCache(): void {
    this.toolCache.clear();
  }
}

// ============================================================================
// TOOL BUILDER
// ============================================================================

export interface ToolBuilderConfig<T extends ToolSchema> {
  name: string;
  description: string;
  schema: T;
  handler: (args: z.infer<z.ZodObject<T>>) => Promise<unknown> | unknown;
}

export function createTool<T extends ToolSchema>(config: ToolBuilderConfig<T>): Tool {
  const schema = z.object(config.schema);

  return {
    name: config.name,
    description: config.description,
    schema: config.schema as Record<string, unknown>,
    handler: async (args: Record<string, unknown>) => {
      const validated = schema.parse(args);
      return config.handler(validated as z.infer<z.ZodObject<T>>);
    },
    call: async (args: Record<string, unknown>) => {
      const validated = schema.parse(args);
      return config.handler(validated as z.infer<z.ZodObject<T>>);
    },
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

export { z, ZodSchema };
