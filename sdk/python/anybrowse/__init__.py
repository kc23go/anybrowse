"""
anybrowse Python SDK

Install: pip install anybrowse

This SDK provides a simple interface for agents to:
1. Register their capabilities with the anybrowse registry
2. Discover tools from other agents
3. Call discovered tools
"""

import os
from typing import Dict, List, Any, Optional, Callable
from dataclasses import dataclass, field
import json
import requests


@dataclass
class Tool:
    """Represents a tool that can be discovered and called."""
    name: str
    description: str
    schema: Dict[str, Any]
    handler: Optional[Callable] = None
    server_id: Optional[str] = None
    
    def call(self, **kwargs) -> Dict[str, Any]:
        """Call this tool with the given arguments."""
        if self.handler:
            return self.handler(**kwargs)
        raise ValueError("No handler available for remote tool")


@dataclass
class Server:
    """Represents a registered server with tools."""
    id: str
    name: str
    description: str
    tools: List[Tool] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)


class Registry:
    """
    Client for the anybrowse registry.
    
    Usage:
        registry = Registry(api_key="your_key")
        
        # Discover tools
        results = registry.discover("I need weather data")
        
        # Register your tools
        registry.register_server(
            name="my-weather-server",
            tools=[get_weather_tool]
        )
    """
    
    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = "https://api.anybrowse.dev/v1"
    ):
        self.api_key = api_key or os.environ.get("ANYBROWSE_API_KEY")
        self.base_url = base_url
        self._session = requests.Session()
        
        if self.api_key:
            self._session.headers.update({
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json"
            })
    
    def discover(
        self,
        query: str,
        category: Optional[str] = None,
        tags: Optional[List[str]] = None,
        limit: int = 10
    ) -> List[Tool]:
        """
        Discover tools matching the query.
        
        Args:
            query: Natural language description of what you need
            category: Filter by category (data, utility, ai, etc.)
            tags: Filter by specific tags
            limit: Maximum results to return
        
        Returns:
            List of matching Tool objects
        """
        params = {
            "q": query,
            "limit": limit
        }
        if category:
            params["category"] = category
        if tags:
            params["tags"] = ",".join(tags)
        
        response = self._session.get(
            f"{self.base_url}/tools/discover",
            params=params
        )
        response.raise_for_status()
        
        data = response.json()
        tools = []
        
        for item in data.get("tools", []):
            tool = Tool(
                name=item["name"],
                description=item["description"],
                schema=item.get("schema", {}),
                server_id=item.get("server_id")
            )
            tools.append(tool)
        
        return tools
    
    def register_server(
        self,
        name: str,
        tools: List[Tool],
        description: str = "",
        metadata: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Register a server and its tools with the registry.
        
        Args:
            name: Unique name for your server
            tools: List of Tool objects to register
            description: Server description
            metadata: Additional metadata (author, license, etc.)
        
        Returns:
            Server ID for the registered server
        """
        if not self.api_key:
            raise ValueError("API key required for registration. Set ANYBROWSE_API_KEY.")
        
        manifest = {
            "name": name,
            "description": description,
            "tools": [
                {
                    "name": tool.name,
                    "description": tool.description,
                    "schema": tool.schema,
                }
                for tool in tools
            ],
            "metadata": metadata or {}
        }
        
        response = self._session.post(
            f"{self.base_url}/servers/register",
            json=manifest
        )
        response.raise_for_status()
        
        result = response.json()
        server_id = result.get("server_id")
        
        # Update tools with server_id
        for tool in tools:
            tool.server_id = server_id
        
        return server_id
    
    def call_tool(
        self,
        server_id: str,
        tool_name: str,
        arguments: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Call a tool on a remote server.
        
        Args:
            server_id: ID of the server hosting the tool
            tool_name: Name of the tool to call
            arguments: Arguments to pass to the tool
        
        Returns:
            Tool execution result
        """
        response = self._session.post(
            f"{self.base_url}/servers/{server_id}/tools/{tool_name}",
            json={"arguments": arguments}
        )
        response.raise_for_status()
        
        return response.json()
    
    def get_server(self, server_id: str) -> Server:
        """Get details about a specific server."""
        response = self._session.get(
            f"{self.base_url}/servers/{server_id}"
        )
        response.raise_for_status()
        
        data = response.json()
        return Server(
            id=data["id"],
            name=data["name"],
            description=data.get("description", ""),
            tools=[
                Tool(
                    name=t["name"],
                    description=t["description"],
                    schema=t.get("schema", {}),
                    server_id=server_id
                )
                for t in data.get("tools", [])
            ],
            metadata=data.get("metadata", {})
        )
    
    def list_categories(self) -> List[str]:
        """List available tool categories."""
        response = self._session.get(f"{self.base_url}/categories")
        response.raise_for_status()
        return response.json().get("categories", [])


class Agent:
    """
    High-level agent interface that combines discovery and execution.
    
    Usage:
        agent = Agent(registry=Registry(api_key="..."))
        
        # The agent automatically discovers and uses tools
        result = agent.use_tool("get weather for San Francisco")
    """
    
    def __init__(self, registry: Registry):
        self.registry = registry
        self._tool_cache: Dict[str, Tool] = {}
    
    def use_tool(self, intent: str, **kwargs) -> Dict[str, Any]:
        """
        Discover and use a tool based on intent.
        
        Args:
            intent: Natural language description of what you want to do
            **kwargs: Additional arguments for the tool
        
        Returns:
            Tool execution result
        """
        # Check cache first
        if intent in self._tool_cache:
            tool = self._tool_cache[intent]
            if tool.handler:
                return tool.call(**kwargs)
            elif tool.server_id:
                return self.registry.call_tool(
                    tool.server_id,
                    tool.name,
                    kwargs
                )
        
        # Discover matching tools
        tools = self.registry.discover(intent, limit=3)
        
        if not tools:
            raise ValueError(f"No tools found for intent: {intent}")
        
        # Use the best match
        tool = tools[0]
        self._tool_cache[intent] = tool
        
        if tool.server_id:
            return self.registry.call_tool(
                tool.server_id,
                tool.name,
                kwargs
            )
        
        raise ValueError(f"Tool {tool.name} has no server_id")
    
    def clear_cache(self):
        """Clear the tool discovery cache."""
        self._tool_cache.clear()


# ============================================================================
# DECORATORS FOR EASY TOOL DEFINITION
# ============================================================================

def tool(description: str, **schema):
    """
    Decorator for marking functions as tools.
    
    Usage:
        @tool("Get weather for a location", location=str, units=str)
        def get_weather(location: str, units: str = "celsius"):
            return {"temperature": 72, "condition": "sunny"}
    """
    def decorator(func: Callable) -> Tool:
        tool_obj = Tool(
            name=func.__name__,
            description=description,
            schema=schema,
            handler=func
        )
        return tool_obj
    return decorator
