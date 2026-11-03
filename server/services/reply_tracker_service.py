import datetime
import re
import httpx
from db import threads_collection

def track_thread(uid: str, thread_id: str, to_email: str, subject: str):
    """
    Register a newly sent thread for reply tracking in MongoDB Atlas.
    """
    entry = {
        "uid": uid,
        "thread_id": thread_id,
        "to_email": to_email,
        "subject": subject,
        "sent_time": datetime.datetime.utcnow().isoformat() + "Z",
        "has_reply": False,
        "dismissed": False,
        "reply_from": "",
        "reply_snippet": "",
        "notified": False,
        "last_notified_msg_id": ""
    }

    try:
        # Avoid duplicate tracking
        existing = threads_collection.find_one({"uid": uid, "thread_id": thread_id})
        if not existing:
            threads_collection.insert_one(entry)
    except Exception as e:
        print(f"[ReplyTracker] Failed to insert tracked thread: {e}")

async def check_for_replies(access_token: str, uid: str, user_email: str) -> list[dict]:
    """
    Scan all active tracked threads for new messages sent by the recipient.
    """
    alerts = []
    try:
        user_threads = list(threads_collection.find({"uid": uid}, {"_id": 0}))
    except Exception as e:
        print(f"[ReplyTracker] Failed to read tracked threads: {e}")
        return []

    if not user_threads:
        return alerts

    headers = {"Authorization": f"Bearer {access_token}"}

    async with httpx.AsyncClient(timeout=10.0) as client:
        for t in user_threads:
            thread_id = t.get("thread_id")
            if not thread_id:
                continue

            try:
                # Fetch full thread details from Gmail API
                resp = await client.get(
                    f"https://gmail.googleapis.com/gmail/v1/users/me/threads/{thread_id}?format=metadata",
                    headers=headers
                )
                if resp.status_code == 200:
                    thread_data = resp.json()
                    messages = thread_data.get("messages", [])
                    
                    # Look for replies (messages not sent by the authenticated user)
                    latest_reply_msg = None
                    latest_reply_from = ""
                    
                    for msg in reversed(messages):
                        msg_headers = {h["name"].lower(): h["value"] for h in msg.get("payload", {}).get("headers", [])}
                        sender = msg_headers.get("from", "")
                        
                        # Check if sender is NOT the user
                        if user_email.lower() not in sender.lower():
                            latest_reply_msg = msg
                            latest_reply_from = sender
                            break
                    
                    if latest_reply_msg:
                        latest_msg_id = latest_reply_msg.get("id")
                        last_notified = t.get("last_notified_msg_id", "")
                        
                        # If this is a new reply we haven't notified yet
                        if latest_msg_id != last_notified:
                            print(f"[ReplyTracker] New reply detected in thread {thread_id}! Message ID: {latest_msg_id}")
                            raw_snippet = latest_reply_msg.get("snippet", "")
                            parts = re.split(r'\s*\bOn\s+.*?\s+wrote:', raw_snippet, flags=re.IGNORECASE)
                            
                            reply_snippet = parts[0].strip() if parts else raw_snippet
                            
                            t["reply_snippet"] = reply_snippet
                            t["reply_from"] = latest_reply_from
                            t["has_reply"] = True
                            t["dismissed"] = False  # Wake alert up!
                            t["last_notified_msg_id"] = latest_msg_id
                            
                            threads_collection.update_one(
                                {"uid": uid, "thread_id": thread_id},
                                {
                                    "$set": {
                                        "reply_snippet": reply_snippet,
                                        "reply_from": latest_reply_from,
                                        "has_reply": True,
                                        "dismissed": False,
                                        "last_notified_msg_id": latest_msg_id
                                    }
                                }
                            )
            except Exception as e:
                print(f"[ReplyTracker] Error checking thread {thread_id}: {e}")

            if t.get("has_reply") and not t.get("dismissed"):
                alerts.append(t)

    return alerts

def dismiss_thread(uid: str, thread_id: str) -> bool:
    """
    Mark a thread's reply alert as dismissed in MongoDB Atlas.
    """
    try:
        res = threads_collection.update_one(
            {"uid": uid, "thread_id": thread_id},
            {"$set": {"dismissed": True}}
        )
        return res.matched_count > 0
    except Exception as e:
        print(f"[ReplyTracker] Failed to dismiss thread: {e}")
        return False
