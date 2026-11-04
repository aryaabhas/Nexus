"""
Search router — semantic search over stored email summaries via Pinecone.
Protected by Firebase ID token auth.
"""

from fastapi import APIRouter, Depends, HTTPException
from middleware.firebase_auth import get_current_user
from pydantic import BaseModel
from services import log_service, openai_service, vector_store

router = APIRouter(prefix="/api/search", tags=["search"])


class SearchRequest(BaseModel):
    query: str
    k: int = 5


@router.post("")
async def semantic_search(
    body: SearchRequest,
    user: dict = Depends(get_current_user),
):
    """
    Search Pinecone within the user's isolated namespace and synthesize
    a direct RAG answer based on the top matches.
    """
    if not body.query.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty.")

    uid = user.get("uid", "")

    try:
        # Search directly in the user's isolated Pinecone namespace
        user_results = vector_store.search(body.query, uid=uid, k=body.k)

        # Synthesize a direct AI answer from the top semantic matches
        ai_answer = ""
        if user_results:
            ai_answer = await openai_service.answer_semantic_query(body.query, user_results)

        log_service.add_log(
            uid=uid,
            email=user.get("email") or "",
            action="SEMANTIC_SEARCH",
            details=f"Ran semantic search for '{body.query}' (Found {len(user_results)} matches).",
            status="SUCCESS"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {e}")

    return {
        "results": user_results,
        "query": body.query,
        "answer": ai_answer
    }
