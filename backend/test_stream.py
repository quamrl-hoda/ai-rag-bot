"""Quick test to see what the streaming endpoint actually returns."""
import asyncio
import httpx

async def test():
    async with httpx.AsyncClient() as client:
        async with client.stream(
            "POST",
            "http://localhost:8000/chat",
            json={"message": "Say hello in 5 words", "conversation_id": "test-debug"},
            timeout=30.0,
        ) as resp:
            print(f"Status: {resp.status_code}")
            print(f"Content-Type: {resp.headers.get('content-type')}")
            print("--- SSE DATA ---")
            async for line in resp.aiter_lines():
                print(repr(line))
            print("--- END ---")

asyncio.run(test())
