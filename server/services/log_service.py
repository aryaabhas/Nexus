import datetime
from db import logs_collection

def add_log(uid: str, email: str, action: str, details: str, status: str = "SUCCESS"):
    """
    Log a user action into MongoDB activity_logs collection.
    """
    entry = {
        "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
        "uid": uid,
        "email": email,
        "action": action,
        "details": details,
        "status": status
    }
    try:
        logs_collection.insert_one(entry)
    except Exception as e:
        print(f"[LogService] Failed to write log: {e}")

def get_user_logs(uid: str) -> list[dict]:
    """
    Get all log entries matching the given Firebase UID, sorted by newest first.
    """
    try:
        logs = list(logs_collection.find({"uid": uid}, {"_id": 0}).sort("timestamp", -1))
        return logs
    except Exception as e:
        print(f"[LogService] Failed to read logs: {e}")
        return []

def clear_user_logs(uid: str):
    try:
        logs_collection.delete_many({"uid": uid})
    except Exception as e:
        print(f"[LogService] Failed to clear user logs: {e}")
