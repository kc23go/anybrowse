"""
Example: Multi-Tool Agent

Shows how an agent can discover and compose multiple tools
from different servers to complete a complex task.
"""

import os
from anybrowse import Registry, Agent, Tool


def create_travel_agent():
    """
    Create a travel agent that discovers and uses multiple tools:
    - Weather tool (for destination weather)
    - Currency tool (for exchange rates)
    - Translation tool (for common phrases)
    """
    
    registry = Registry(api_key=os.environ.get("ANYBROWSE_API_KEY"))
    agent = Agent(registry)
    
    return agent


def plan_trip(destination: str, origin: str, dates: str):
    """
    Plan a trip by composing multiple agent-discovered tools.
    
    This demonstrates how agents can dynamically discover and use
tools without hardcoded integrations.
    """
    
    print(f"🌍 Planning trip from {origin} to {destination} for {dates}")
    print()
    
    agent = create_travel_agent()
    
    # Discover and use weather tool
    print("🌤️ Checking weather...")
    try:
        weather = agent.use_tool(
            f"get weather for {destination}",
            location=destination
        )
        print(f"   Weather: {weather.get('temperature')}°{weather.get('units', 'C')}, "
              f"{weather.get('condition')}")
    except Exception as e:
        print(f"   Could not get weather: {e}")
    
    print()
    
    # Discover and use currency tool
    print("💱 Checking exchange rates...")
    try:
        # Try to discover a currency conversion tool
        rates = agent.use_tool(
            f"convert USD to local currency for {destination}",
            from_currency="USD",
            amount=100
        )
        print(f"   $100 USD = {rates}")
    except Exception as e:
        print(f"   Could not get exchange rates: {e}")
    
    print()
    
    # Discover and use translation tool
    print("🗣️ Getting useful phrases...")
    try:
        phrases = agent.use_tool(
            f"translate common travel phrases to language of {destination}",
            phrases=["Hello", "Thank you", "Where is the bathroom?", "How much?"]
        )
        print(f"   Phrases: {phrases}")
    except Exception as e:
        print(f"   Could not get translations: {e}")
    
    print()
    print("✅ Trip planning complete!")
    
    return {
        "destination": destination,
        "weather": weather if 'weather' in locals() else None,
        "rates": rates if 'rates' in locals() else None,
        "phrases": phrases if 'phrases' in locals() else None
    }


if __name__ == "__main__":
    print("=" * 60)
    print("anybrowse SDK Example: Multi-Tool Travel Agent")
    print("=" * 60)
    print()
    
    # Example trip planning
    # Note: This requires registered tools in the anybrowse registry
    try:
        plan = plan_trip(
            destination="Tokyo",
            origin="San Francisco",
            dates="2026-04-15 to 2026-04-22"
        )
    except Exception as e:
        print(f"\nNote: This example requires registered tools in the anybrowse registry.")
        print(f"Error: {e}")
        print("\nTo make this work:")
        print("1. Register weather, currency, and translation tools")
        print("2. Set ANYBROWSE_API_KEY environment variable")
        print("3. Run this example again")
