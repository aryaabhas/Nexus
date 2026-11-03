import time
import uuid

from fastapi import APIRouter, Depends, HTTPException
from middleware.firebase_auth import get_current_user
from pydantic import BaseModel
from db import tasks_collection

router = APIRouter(prefix="/api/tasks", tags=["tasks"])

class TaskSchema(BaseModel):
    id: str | None = None
    title: str
    description: str | None = ""
    status: str  # "todo", "inprogress", "done"
    client_email: str | None = ""
    company: str | None = ""

@router.get("")
@router.get("/")
async def get_tasks(user: dict = Depends(get_current_user)):
    uid = user.get("uid", "")
    tasks = list(tasks_collection.find({"uid": uid}, {"_id": 0}))
    return {"tasks": tasks}

@router.post("")
@router.post("/")
async def save_task(body: TaskSchema, user: dict = Depends(get_current_user)):
    uid = user.get("uid", "")
    email_addr = user.get("email") or ""

    from services import log_service
    if body.id:
        # Update existing
        update_fields = {
            "title": body.title,
            "description": body.description or "",
            "status": body.status,
            "client_email": body.client_email or "",
            "company": body.company or ""
        }
        res = tasks_collection.update_one(
            {"id": body.id, "uid": uid},
            {"$set": update_fields}
        )
        if res.matched_count == 0:
            log_service.add_log(uid, email_addr, "EDIT_TASK", f"Failed to edit task {body.id}: Not found.", "ERROR")
            raise HTTPException(status_code=404, detail="Task not found")

        task_data = tasks_collection.find_one({"id": body.id, "uid": uid}, {"_id": 0})
        log_service.add_log(uid, email_addr, "EDIT_TASK", f"Updated task ticket '{body.title}' details.", "SUCCESS")
    else:
        # Create new
        task_data = {
            "id": f"task_{uuid.uuid4().hex[:8]}",
            "uid": uid,
            "title": body.title,
            "description": body.description or "",
            "status": body.status,
            "client_email": body.client_email or "",
            "company": body.company or "",
            "created_at": time.time()
        }
        tasks_collection.insert_one(dict(task_data))
        log_service.add_log(uid, email_addr, "CREATE_TASK", f"Created new task ticket '{body.title}' inside column '{body.status}'.", "SUCCESS")

    return {"status": "success", "task": task_data}

@router.delete("/{task_id}")
async def delete_task(task_id: str, user: dict = Depends(get_current_user)):
    uid = user.get("uid", "")
    email_addr = user.get("email") or ""
    
    from services import log_service
    res = tasks_collection.delete_one({"id": task_id, "uid": uid})
    if res.deleted_count == 0:
        log_service.add_log(uid, email_addr, "DELETE_TASK", f"Failed to delete task {task_id}: Not found.", "ERROR")
        raise HTTPException(status_code=404, detail="Task not found")

    
    _save_tasks(new_tasks)
    log_service.add_log(uid, email_addr, "DELETE_TASK", f"Deleted task ticket (ID: {task_id}) from Operations Kanban board.", "SUCCESS")
    return {"status": "deleted"}

@router.post("/clear")
async def clear_tasks(user: dict = Depends(get_current_user)):
    uid = user.get("uid", "")
    email_addr = user.get("email") or ""
    all_tasks = _load_tasks()
    remaining_tasks = [t for t in all_tasks if t.get("uid") != uid]
    _save_tasks(remaining_tasks)
    
    from services import log_service
    log_service.add_log(uid, email_addr, "PURGE_TASKS", "Wiped all user tasks and columns from the server operations board database.", "SUCCESS")
    return {"status": "success"}
