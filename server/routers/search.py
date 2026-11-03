"""
Search router — semantic search over stored email summaries via FAISS.
Protected by Firebase ID token auth.
"""

from fastapi import APIRouter, Depends, HTTPException
from middleware.firebase_auth import get_current_user
from pydantic import BaseModel
from services import vector_store

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
    Embed the query using all-MiniLM-L6-v2 (locally) and return the
    top-k most semantically similar email summaries from FAISS.
    Results are filtered to the requesting user's stored emails.
    """
    if not body.query.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty.")

    uid = user.get("uid", "")

    try:
        # Search directly in the user's isolated Pinecone namespace
        user_results = vector_store.search(body.query, uid=uid, k=body.k)
        from services import log_service
        log_service.add_log(
            uid=uid,
            email=user.get("email") or "",
            action="SEMANTIC_SEARCH",
            details=f"Ran semantic search for '{body.query}' (Found {len(user_results)} matches).",
            status="SUCCESS"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {e}")

    return {"results": user_results, "query": body.query}
