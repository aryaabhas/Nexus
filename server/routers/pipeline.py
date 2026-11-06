"""
Router for Client Pipeline & Living Incident Intelligence.
Endpoints for logging natural language incidents, fetching Kanban board data,
generating analytical sales stage reports, viewing client discussion history,
and generating post-closure deal dossiers.
"""

from fastapi import APIRouter, Depends, HTTPException
from middleware.firebase_auth import get_current_user
from pydantic import BaseModel
from services import pipeline_service

router = APIRouter(prefix="/api/pipeline", tags=["pipeline"])


class IncidentRequest(BaseModel):
    text: str


class QueryRequest(BaseModel):
    query: str


@router.post("/incident")
async def log_incident_route(body: IncidentRequest, user: dict = Depends(get_current_user)):
    """
    Log an unstructured natural language incident or update about a client.
    Applies stateful delta updates, preserves existing deal stages/values,
    and indexes into Pinecone vector memory.
    """
    uid = user.get("uid", "")
    if not body.text or not body.text.strip():
        raise HTTPException(status_code=400, detail="Incident update text cannot be empty.")
    
    try:
        result = await pipeline_service.extract_and_merge_incident(uid=uid, text=body.text.strip())
        return {"status": "success", "data": result}
    except Exception as e:
        print(f"[PipelineRouter] Error logging incident: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to process client incident: {e}")


@router.get("/board")
async def get_pipeline_board_route(user: dict = Depends(get_current_user)):
    """
    Retrieve all tracked clients grouped by stage (Discovery, Proposal, Negotiation, Final Closure, etc.)
    with aggregated counts and values.
    """
    uid = user.get("uid", "")
    try:
        data = pipeline_service.get_pipeline_board(uid=uid)
        return data
    except Exception as e:
        print(f"[PipelineRouter] Error fetching board: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch pipeline board: {e}")


@router.post("/query")
async def query_pipeline_route(body: QueryRequest, user: dict = Depends(get_current_user)):
    """
    Execute analytical sales queries (e.g. 'What are open sales and how many on final closure?').
    Combines verified MongoDB aggregation counts with Pinecone vector memory and LLM synthesis.
    """
    uid = user.get("uid", "")
    if not body.query or not body.query.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty.")

    try:
        report = await pipeline_service.query_pipeline_and_generate_report(uid=uid, query=body.query.strip())
        return report
    except Exception as e:
        print(f"[PipelineRouter] Error running pipeline query: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to generate sales report: {e}")


@router.get("/client/{client_id}/history")
async def get_client_history_route(client_id: str, user: dict = Depends(get_current_user)):
    """
    Fetch the complete chronological history of discussions and incident updates
    for a specific client or company.
    """
    uid = user.get("uid", "")
    try:
        data = pipeline_service.get_client_history(uid=uid, client_id_or_company=client_id)
        if not data.get("client"):
            raise HTTPException(status_code=404, detail="Client not found in pipeline.")
        return data
    except HTTPException:
        raise
    except Exception as e:
        print(f"[PipelineRouter] Error fetching client history: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch client history: {e}")


@router.post("/client/{client_id}/dossier")
async def generate_client_dossier_route(client_id: str, user: dict = Depends(get_current_user)):
    """
    Generate an executive, board-ready Client Deal Dossier & Post-Closure Sales Report
    synthesizing all discussions, timeline of events, agreements, and final terms.
    """
    uid = user.get("uid", "")
    try:
        dossier = await pipeline_service.generate_client_closure_dossier(uid=uid, client_id_or_company=client_id)
        return dossier
    except ValueError as ve:
        raise HTTPException(status_code=404, detail=str(ve))
    except Exception as e:
        print(f"[PipelineRouter] Error generating deal dossier: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to generate deal dossier: {e}")


@router.delete("/client/{client_id}")
async def delete_client_route(client_id: str, user: dict = Depends(get_current_user)):
    """
    Permanently delete a client from the pipeline.
    """
    uid = user.get("uid", "")
    success = pipeline_service.delete_pipeline_client(uid=uid, client_id=client_id)
    if not success:
        raise HTTPException(status_code=404, detail="Client not found or could not be deleted.")
    return {"status": "deleted", "client_id": client_id}
