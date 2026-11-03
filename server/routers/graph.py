"""
Graph router — endpoints for Knowledge Graph querying and rebuilding.
"""

from fastapi import APIRouter, Depends, HTTPException
from middleware.firebase_auth import get_current_user
from services import graph_service, log_service, openai_service, vector_store

router = APIRouter(prefix="/api/graph", tags=["graph"])


@router.get("")
async def get_graph(user: dict = Depends(get_current_user)):
    """
    Get the knowledge graph (nodes + edges) for the requesting user.
    """
    uid = user.get("uid", "")
    graph = graph_service.get_user_graph(uid)
    return graph


@router.post("/rebuild")
async def rebuild_graph(user: dict = Depends(get_current_user)):
    """
    Backfill/rebuild the Knowledge Graph from all existing stored email summaries.
    Bypasses expensive API calls if the current graph matches stored summary counts.
    """
    uid = user.get("uid", "")
    email_addr = user.get("email") or ""
    all_summaries = vector_store.get_all_summaries()
    user_summaries = [s for s in all_summaries if s.get("uid") == uid]

    # Check if a populated graph is already stored matching this summary count
    current_graph = graph_service.get_user_graph(uid)
    email_nodes_count = sum(1 for n in current_graph.get("nodes", []) if n.get("type") == "email")

    if len(user_summaries) > 0 and email_nodes_count == len(user_summaries):
        print(f"[GraphOptimize] Graph email count ({email_nodes_count}) matches FAISS summaries count ({len(user_summaries)}). Skipping LLM rebuild.")
        return {
            "status": "success",
            "processed_emails": 0,
            "nodes_count": len(current_graph["nodes"]),
            "edges_count": len(current_graph["edges"]),
            "message": "Graph already up to date. Rebuild bypassed to conserve API tokens."
        }

    processed_count = 0
    try:
        for item in user_summaries:
            msg_id = item.get("message_id")
            subject = item.get("subject", "")
            sender = item.get("from", "")
            date = item.get("date", "")
            summary = item.get("summary", "")

            if not msg_id:
                continue

            # Extract entities using LLM
            entities = await openai_service.extract_graph_entities(subject, summary)
            
            # Add to graph
            graph_service.add_email_to_graph(
                message_id=msg_id,
                subject=subject,
                sender_raw=sender,
                date=date,
                summary=summary,
                uid=uid,
                extracted_entities=entities
            )
            processed_count += 1

        log_service.add_log(uid, email_addr, "REBUILD_GRAPH", f"Successfully rebuilt Knowledge Graph from {processed_count} summaries.", "SUCCESS")
    except Exception as e:
        log_service.add_log(uid, email_addr, "REBUILD_GRAPH", f"Failed to rebuild Knowledge Graph: {e!s}", "ERROR")
        raise HTTPException(status_code=500, detail=str(e))

    graph = graph_service.get_user_graph(uid)
    return {
        "status": "success",
        "processed_emails": processed_count,
        "nodes_count": len(graph["nodes"]),
        "edges_count": len(graph["edges"])
    }


from pydantic import BaseModel


class AskGraphRequest(BaseModel):
    query: str


@router.get("/analytics")
async def get_graph_analytics(user: dict = Depends(get_current_user)):
    """
    Get graph analytics including PageRank centrality scores, weighted relationship edges, and detected anomalies.
    """
    uid = user.get("uid", "")
    analytics = graph_service.get_graph_analytics(uid)
    return analytics


@router.post("/ask")
async def ask_graph_endpoint(req: AskGraphRequest, user: dict = Depends(get_current_user)):
    """
    Ask natural language questions about graph structure, entity connections, or anomalies using LLM RAG.
    """
    if not req.query or not req.query.strip():
        raise HTTPException(status_code=400, detail="Query string cannot be empty.")
    
    uid = user.get("uid", "")
    res = await graph_service.ask_graph(req.query.strip(), uid)
    return res

