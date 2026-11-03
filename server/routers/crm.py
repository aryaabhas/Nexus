import time
from fastapi import APIRouter, Depends, HTTPException
from middleware.firebase_auth import get_current_user
from pydantic import BaseModel
from db import crm_collection

router = APIRouter(prefix="/api/crm", tags=["crm"])

class InteractionSchema(BaseModel):
    client_email: str
    date: str
    topic: str
    outcome: str
    has_grievance: bool

@router.get("/interactions")
async def get_interactions(client_email: str | None = None, user: dict = Depends(get_current_user)):
    uid = user.get("uid", "")
    query = {"uid": uid}
    if client_email:
        query["client_email"] = client_email.strip().lower()
    
    logs = list(crm_collection.find(query, {"_id": 0}).sort("date", -1))
    return {"interactions": logs}

@router.post("/interactions")
async def add_interaction(body: InteractionSchema, user: dict = Depends(get_current_user)):
    uid = user.get("uid", "")
    email_addr = user.get("email") or ""
    
    new_log = {
        "id": f"int_{int(time.time())}",
        "uid": uid,
        "client_email": body.client_email.strip().lower(),
        "date": body.date,
        "topic": body.topic,
        "outcome": body.outcome,
        "has_grievance": body.has_grievance,
        "created_at": time.time()
    }
    crm_collection.insert_one(dict(new_log))
        
    from services import log_service
    log_service.add_log(uid, email_addr, "LOG_TOUCHPOINT", f"Logged CRM touchpoint for '{body.client_email}' on {body.date} (Grievance: {body.has_grievance}).", "SUCCESS")
    return {"status": "success", "interaction": new_log}

@router.put("/interactions/{interaction_id}")
async def update_interaction(interaction_id: str, body: InteractionSchema, user: dict = Depends(get_current_user)):
    uid = user.get("uid", "")
    email_addr = user.get("email") or ""

    update_fields = {
        "client_email": body.client_email.strip().lower(),
        "date": body.date,
        "topic": body.topic,
        "outcome": body.outcome,
        "has_grievance": body.has_grievance
    }
    res = crm_collection.update_one(
        {"id": interaction_id, "uid": uid},
        {"$set": update_fields}
    )
    if res.matched_count == 0:
        from services import log_service
        log_service.add_log(uid, email_addr, "EDIT_TOUCHPOINT", f"Failed to edit touchpoint {interaction_id}: Not found.", "ERROR")
        raise HTTPException(status_code=404, detail="Touchpoint not found")
        
    target_log = crm_collection.find_one({"id": interaction_id, "uid": uid}, {"_id": 0})
    from services import log_service
    log_service.add_log(uid, email_addr, "EDIT_TOUCHPOINT", f"Updated CRM touchpoint details for '{body.client_email}' (Grievance: {body.has_grievance}).", "SUCCESS")
    return {"status": "success", "interaction": target_log}

@router.get("/analytics")
async def get_analytics(user: dict = Depends(get_current_user)):
    uid = user.get("uid", "")
    user_logs = list(crm_collection.find({"uid": uid}, {"_id": 0}))
    
    # Track unique client emails with active grievances
    grievances_map = {}
    for log in user_logs:
        email = log.get("client_email", "").strip().lower()
        if not email:
            continue
        if email not in grievances_map or log.get("created_at", 0) > grievances_map[email].get("created_at", 0):
            grievances_map[email] = log
            
    active_grievances_count = sum(1 for log in grievances_map.values() if log.get("has_grievance"))
    active_grievance_emails = [email for email, log in grievances_map.items() if log.get("has_grievance")]
    
    return {
        "total_interactions": len(user_logs),
        "active_grievances": active_grievances_count,
        "grievance_emails": active_grievance_emails
    }
