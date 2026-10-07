from langgraph.graph import StateGraph, START, END
from typing import TypedDict, Annotated
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage, AIMessageChunk
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode,tools_condition
from langchain_community.tools import DuckDuckGoSearchRun
from langchain_core.tools import tool
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import uvicorn
import sqlite3
import aiosqlite
import requests
import json
import asyncio
from langchain_mcp_adapters.client import MultiServerMCPClient

# ── Load env & model ────────────────────────────────────────────
load_dotenv()
llm = ChatOpenAI(model="gpt-5",streaming=True)

client = MultiServerMCPClient(
   {   "arith":{
        "transport":"stdio",
        "command":"C:\\Users\\quamr\\AppData\\Roaming\\Python\\Python313\\Scripts\\uv.exe",
        "args": [
            "run",
            "fastmcp",
            "run",
            "C:\\Users\\quamr\\OneDrive\\Desktop\\project3\\mcp-math-server\\main.py"
        ]
    },
      "expense": {
        "transport": "streamable_http",
        "url": "https://net-turquoise-roadrunner.fastmcp.app/mcp",
        "headers": {
            "Authorization": "Bearer fmcp_fz2otILNUO7cGpkZhGCUOep5Xe3DMeqi_NcymQ8FRCQ"
        }
    },
    }
)

# Tools
search_tool = DuckDuckGoSearchRun(region='us-end')

@tool
def get_stock_price(symbol:str)->dict:
    """
    Fetch latest stock market price for a given symbol (e.g 'AAPL','TSLA','GOOG')
    """
    url = f"https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol={symbol}&apikey=186PBD1K8J817LMV"
    r = requests.get(url)
    return r.json()

# ── Fetch MCP tools & bind ALL tools in one place ───────────────
mcp_tools_list = asyncio.run(client.get_tools())
all_tools = [search_tool, get_stock_price] + mcp_tools_list
llm_with_tools = llm.bind_tools(all_tools)
tool_node = ToolNode(all_tools)


# ── LangGraph chatbot ───────────────────────────────────────────
class ChatState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]

async def chat_node(state: ChatState):
    message = state['messages']
    response = await llm_with_tools.ainvoke(message)
    return {"messages": [response]}

# ── Build the graph ─────────────────────────────────────────────
def build_graph():
    graph = StateGraph(ChatState)
    graph.add_node("chat_node", chat_node)
    graph.add_node("tools", tool_node)
    graph.add_edge(START, "chat_node")
    graph.add_conditional_edges('chat_node', tools_condition)
    graph.add_edge("tools", "chat_node")
    return graph

# ── Sync checkpointer — for get_state, list (conversations API) ─
conn = sqlite3.connect(database='chatbot.db', check_same_thread=False)
sync_checkpointer = SqliteSaver(conn=conn)
chatbot_sync = build_graph().compile(checkpointer=sync_checkpointer)

# ── Async chatbot (initialized at startup via lifespan) ─────────
chatbot = None

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app):
    """Initialize AsyncSqliteSaver on startup, clean up on shutdown."""
    global chatbot
    async with AsyncSqliteSaver.from_conn_string("chatbot.db") as async_checkpointer:
        chatbot = build_graph().compile(checkpointer=async_checkpointer)
        yield
    chatbot = None



def retrieve_all_threads():
    """Use the LangGraph checkpointer API to get all unique thread_ids."""
    all_threads = set()
    for checkpoint in sync_checkpointer.list(None):
        all_threads.add(checkpoint.config['configurable']['thread_id'])
    return list(all_threads)


# ── FastAPI server ──────────────────────────────────────────────
app = FastAPI(title="AI RAG Bot", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    message: str
    conversation_id: str = "default"


@app.post("/chat")
async def chat_endpoint(req: ChatRequest):
    """
    Streams AI responses token-by-token via Server-Sent Events (SSE).
    Uses astream_events to capture individual LLM tokens as they are generated.
    SqliteSaver automatically restores conversation history by thread_id.
    """
    config = {
        "configurable": {"thread_id": req.conversation_id},
        "metadata": {
            "thread_id": req.conversation_id
        },
        "run_name": "chat_turn",
    }

    async def event_generator():
        """Yield SSE events for each streamed token from the LLM."""
        try:
            async for msg, metadata in chatbot.astream(
                {"messages": [HumanMessage(content=req.message)]},
                config=config,
                stream_mode="messages",
            ):
                # Only stream text tokens from the chat model node
                if (
                    isinstance(msg, AIMessageChunk)
                    and msg.content
                    and isinstance(msg.content, str)
                    and metadata.get("langgraph_node") == "chat_node"
                ):
                    payload = json.dumps({"content": msg.content})
                    yield f"data: {payload}\n\n"

            # Signal end of stream
            yield "data: [DONE]\n\n"

        except Exception as e:
            error_payload = json.dumps({"error": str(e)})
            yield f"data: {error_payload}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/conversations")
async def list_conversations():
    """
    Returns all unique thread_ids from the SQLite checkpoint DB
    via the LangGraph checkpointer API (reliable across versions).
    Each entry also includes the title (first user message) for sidebar display.
    """
    try:
        thread_ids = retrieve_all_threads()
    except Exception as e:
        return {"threads": [], "error": str(e)}

    threads = []
    for tid in thread_ids:
        try:
            config = {"configurable": {"thread_id": tid}}
            state = chatbot_sync.get_state(config)
            msgs = state.values.get("messages", []) if state and state.values else []

            # Title = first user message content (truncated)
            title = tid[:8] + "…"
            for m in msgs:
                if isinstance(m, HumanMessage) and m.content.strip():
                    title = m.content.strip()[:50]
                    break

            threads.append({"id": tid, "title": title, "msg_count": len(msgs)})
        except Exception:
            threads.append({"id": tid, "title": tid[:8] + "…", "msg_count": 0})

    return {"threads": threads}


@app.get("/conversations/{thread_id}")
async def get_conversation(thread_id: str):
    """
    Returns the full message history for a given thread_id,
    reconstructed from the latest LangGraph checkpoint.
    """
    config = {"configurable": {"thread_id": thread_id}}
    try:
        state = chatbot_sync.get_state(config)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    if not state or not state.values:
        raise HTTPException(status_code=404, detail="Conversation not found")

    messages = []
    for msg in state.values.get("messages", []):
        if isinstance(msg, HumanMessage):
            messages.append({"role": "user", "content": msg.content})
        elif isinstance(msg, AIMessage):
            messages.append({"role": "assistant", "content": msg.content})

    return {"thread_id": thread_id, "messages": messages}


@app.delete("/conversations/{thread_id}")
async def delete_conversation(thread_id: str):
    """Deletes all checkpoints for a given thread_id using raw SQL."""
    cursor = conn.cursor()
    try:
        # Try both possible table names depending on langgraph version
        for table in ["checkpoints", "checkpoint_writes", "checkpoint_blobs"]:
            try:
                cursor.execute(f"DELETE FROM {table} WHERE thread_id = ?", (thread_id,))
            except Exception:
                pass
        conn.commit()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"deleted": thread_id}


@app.get("/health")
async def health():
    return {"status": "ok"}

# ── Run with: python backend/main.py ────────────────────────────
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
