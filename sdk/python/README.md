# anybrowse Python SDK

Official Python SDK for interacting with the anybrowse agent-to-agent registry.

## Installation

```bash
pip install anybrowse
```

## Quick Start

### Discover Tools

```python
from anybrowse import Registry

# Initialize registry client
registry = Registry(api_key="your_api_key")

# Discover tools by natural language query
tools = registry.discover("I need to get weather data")

for tool in tools:
    print(f"Found: {tool.name} - {tool.description}")
```

### Register Your Tools

```python
from anybrowse import Registry, Tool

# Define your tools
weather_tool = Tool(
    name="get_weather",
    description="Get current weather for a location",
    schema={
        "location": str,
        "units": str
    }
)

# Register with anybrowse
registry = Registry(api_key="your_api_key")
server_id = registry.register_server(
    name="my-weather-server",
    tools=[weather_tool],
    description="Weather data provider"
)

print(f"Server registered: {server_id}")
```

### Use the Agent Interface

```python
from anybrowse import Agent, Registry

agent = Agent(registry=Registry(api_key="..."))

# The agent discovers and calls the right tool
result = agent.use_tool(
    "get weather for San Francisco",
    location="San Francisco",
    units="celsius"
)

print(result)
```

### Using the Decorator

```python
from anybrowse import Registry, tool

# Define a tool with the decorator
@tool("Calculate the square root of a number", number=float)
def sqrt(number: float) -> dict:
    return {"result": number ** 0.5}

# Register it
registry = Registry(api_key="...")
registry.register_server(
    name="math-utils",
    tools=[sqrt]
)
```

## API Reference

### Registry

The main client for interacting with the anybrowse registry.

#### `Registry(api_key=None, base_url="https://api.anybrowse.dev/v1")`

Initialize the registry client.

**Parameters:**
- `api_key`: Your anybrowse API key (or set `ANYBROWSE_API_KEY` env var)
- `base_url`: Registry API endpoint

#### `discover(query, category=None, tags=None, limit=10)`

Find tools matching a natural language query.

**Parameters:**
- `query`: What you're looking for (e.g., "weather data")
- `category`: Filter by category
- `tags`: Filter by tags
- `limit`: Max results

**Returns:** List of `Tool` objects

#### `register_server(name, tools, description="", metadata=None)`

Register your server and tools with the registry.

**Parameters:**
- `name`: Unique server name
- `tools`: List of `Tool` objects
- `description`: Server description
- `metadata`: Additional metadata

**Returns:** Server ID string

#### `call_tool(server_id, tool_name, arguments)`

Call a remote tool.

**Parameters:**
- `server_id`: Server hosting the tool
- `tool_name`: Tool name
- `arguments`: Dict of arguments

### Tool

Represents a discoverable tool.

```python
Tool(
    name="my_tool",
    description="What this tool does",
    schema={"param1": str, "param2": int},
    handler=my_function  # Optional: local handler
)
```

### Agent

High-level interface for automatic tool discovery and usage.

```python
agent = Agent(registry)
result = agent.use_tool("intent description", **args)
```

## Environment Variables

- `ANYBROWSE_API_KEY`: Your API key
- `ANYBROWSE_BASE_URL`: Override default API endpoint

## Examples

See the `examples/` directory for:
- `weather_agent.py` - Complete weather tool example
- `calculator_server.py` - Math utilities
- `multi_tool_agent.py` - Agent using multiple tools

## License

MIT
