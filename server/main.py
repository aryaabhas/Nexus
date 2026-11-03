"""
FastAPI application entry point.

Startup sequence:
  1. Load environment variables from .env
  2. Pre-load FAISS index and all-MiniLM-L6-v2 model (via vector_store.load_store)
  3. Mount routers and configure CORS

Run in development:
  uvicorn main:app --reload --port 8000
"""

import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()  # Load .env before anything else

from routers import auth, crm, emails, graph, logs, profile, search, tasks
from services import graph_service, vector_store

# ── Lifespan (startup / shutdown) ────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: pre-load FAISS index and sentence-transformer model
    print("[Startup] Initialising vector store and embedding model…")
    vector_store.load_store()
    print("[Startup] Loading Knowledge Graph…")
    graph_service.load_graph()
    print("[Startup] Ready.")
    yield
    # Shutdown: nothing special needed (index already saved on every write)
    print("[Shutdown] Server shutting down.")


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Email Tracker API",
    description=(
        "Firebase Auth + Gmail API + GPT-4o-mini + FAISS vector store "
        "for AI-powered email summarisation and semantic search."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# ── CORS ──────────────────────────────────────────────────────────────────────
# In production replace "*" origins with your actual frontend URL
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://nexus-eta-ruddy.vercel.app",
    ],
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(auth.router)
app.include_router(emails.router)
app.include_router(search.router)
app.include_router(graph.router)
app.include_router(logs.router)
app.include_router(tasks.router)
app.include_router(crm.router)
app.include_router(profile.router)


# ── Root & Health check ───────────────────────────────────────────────────────
@app.get("/")
async def root():
    return {
        "message": "Email Tracker FastAPI Backend is running!",
        "frontend_url": "http://localhost:5173",
        "api_docs": "http://localhost:8000/docs"
    }


@app.get("/api/health", tags=["health"])
async def health():
    status = {
        "status": "ok",
        "services": {
            "mongodb": "unknown",
            "pinecone": "unknown",
            "r2_cloudflare": "unknown"
        }
    }
    
    # 1. MongoDB check
    try:
        from db import client as mongo_client
        mongo_client.admin.command('ping')
        status["services"]["mongodb"] = "connected"
    except Exception as e:
        status["services"]["mongodb"] = f"error: {str(e)}"

    # 2. Pinecone check
    try:
        from services.vector_store import _get_index
        idx = _get_index()
        if idx is not None:
            status["services"]["pinecone"] = "connected"
        else:
            status["services"]["pinecone"] = "not_initialized"
    except Exception as e:
        status["services"]["pinecone"] = f"error: {str(e)}"

    # 3. Cloudflare R2 check
    try:
        from services.r2_service import s3_client, R2_BUCKET_NAME
        s3_client.head_bucket(Bucket=R2_BUCKET_NAME)
        status["services"]["r2_cloudflare"] = "connected"
    except Exception as e:
        status["services"]["r2_cloudflare"] = f"error: {str(e)}"

    return status


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
