"""
Example: Weather Agent with anybrowse SDK

This example shows how to:
1. Define a weather tool
2. Register it with anybrowse
3. Discover and use it from another agent
"""

import os
from anybrowse import Registry, Tool, Agent, tool


# ============================================================================
# PART 1: Define and Register a Weather Tool
# ============================================================================

def create_weather_tool():
    """Create a weather tool with a local handler."""
    
    def get_weather_handler(location: str, units: str = "celsius"):
        """Mock weather API - replace with real API call."""
        # In production, call OpenWeatherMap, WeatherAPI, etc.
        mock_data = {
            "San Francisco": {"temp": 18, "condition": "Foggy"},
            "New York": {"temp": 25, "condition": "Sunny"},
            "London": {"temp": 15, "condition": "Rainy"},
        }
        
        data = mock_data.get(location, {"temp": 20, "condition": "Clear"})
        
        if units == "fahrenheit":
            data["temp"] = data["temp"] * 9/5 + 32
        
        return {
            "location": location,
            "temperature": data["temp"],
            "units": units,
            "condition": data["condition"]
        }
    
    return Tool(
        name="get_weather",
        description="Get current weather conditions for a location. Use this when you need temperature, conditions, or forecast data.",
        schema={
            "location": str,
            "units": str
        },
        handler=get_weather_handler
    )


def register_weather_server():
    """Register the weather tool with anybrowse."""
    
    api_key = os.environ.get("ANYBROWSE_API_KEY")
    if not api_key:
        print("Set ANYBROWSE_API_KEY to register")
        return
    
    registry = Registry(api_key=api_key)
    weather_tool = create_weather_tool()
    
    server_id = registry.register_server(
        name="weather-provider",
        tools=[weather_tool],
        description="Provides current weather data for any location",
        metadata={
            "author": "Your Name",
            "license": "MIT"
        }
    )
    
    print(f"✅ Weather server registered: {server_id}")
    return server_id


# ============================================================================
# PART 2: Using the Decorator Syntax
# ============================================================================

@tool(
    "Convert temperature between celsius and fahrenheit",
    temperature=float,
    from_unit=str,
    to_unit=str
)
def convert_temperature(temperature: float, from_unit: str, to_unit: str) -> dict:
    """Temperature conversion tool."""
    if from_unit == to_unit:
        return {"temperature": temperature, "unit": to_unit}
    
    if from_unit == "celsius" and to_unit == "fahrenheit":
        converted = temperature * 9/5 + 32
    elif from_unit == "fahrenheit" and to_unit == "celsius":
        converted = (temperature - 32) * 5/9
    else:
        raise ValueError(f"Unknown units: {from_unit}, {to_unit}")
    
    return {"temperature": converted, "unit": to_unit}


# ============================================================================
# PART 3: Discover and Use Tools
# ============================================================================

def discover_and_use():
    """Example of discovering and using tools."""
    
    registry = Registry()  # Uses ANYBROWSE_API_KEY from env
    
    # Discover weather tools
    print("🔍 Discovering weather tools...")
    tools = registry.discover("weather data", limit=5)
    
    if not tools:
        print("No weather tools found")
        return
    
    print(f"Found {len(tools)} weather tools:")
    for tool in tools:
        print(f"  - {tool.name}: {tool.description}")
    
    # Use the first tool
    weather_tool = tools[0]
    print(f"\n🌤️ Using {weather_tool.name}...")
    
    if weather_tool.handler:
        result = weather_tool.call(location="San Francisco", units="celsius")
        print(f"Result: {result}")
    else:
        # Remote tool - call through registry
        result = registry.call_tool(
            weather_tool.server_id,
            weather_tool.name,
            {"location": "San Francisco", "units": "celsius"}
        )
        print(f"Result: {result}")


# ============================================================================
# PART 4: Agent Interface
# ============================================================================

def use_agent_interface():
    """Example using the high-level Agent interface."""
    
    registry = Registry()
    agent = Agent(registry)
    
    # The agent automatically discovers and uses the right tool
    print("🤖 Agent finding and using weather tool...")
    
    try:
        result = agent.use_tool(
            "get weather for San Francisco",
            location="San Francisco",
            units="celsius"
        )
        print(f"Weather: {result}")
    except ValueError as e:
        print(f"Error: {e}")


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    print("=" * 60)
    print("anybrowse SDK Example: Weather Agent")
    print("=" * 60)
    
    # Example 1: Local tool usage
    print("\n1️⃣ Local tool usage:")
    tool = create_weather_tool()
    result = tool.call(location="San Francisco", units="celsius")
    print(f"   Weather in SF: {result['temperature']}°C, {result['condition']}")
    
    # Example 2: Decorator
    print("\n2️⃣ Using decorator syntax:")
    result = convert_temperature(20, "celsius", "fahrenheit")
    print(f"   20°C = {result['temperature']}°F")
    
    # Example 3: Registration (requires API key)
    print("\n3️⃣ Registration (requires ANYBROWSE_API_KEY):")
    server_id = register_weather_server()
    
    # Example 4: Discovery (requires registered servers)
    print("\n4️⃣ Discovery (requires registered servers):")
    try:
        discover_and_use()
    except Exception as e:
        print(f"   (Skipped - no API key or registered servers)")
    
    print("\n" + "=" * 60)
    print("Example complete!")
    print("=" * 60)
