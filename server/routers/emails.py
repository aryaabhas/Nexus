"""
Emails router — fetch from Gmail, summarize, and store in FAISS / Pinecone.
All routes are protected by Firebase ID token auth.
"""

import base64
import json
import os

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
import httpx
from middleware.firebase_auth import get_current_user
from pydantic import BaseModel
from services import (
    gmail_service,
    graph_service,
    log_service,
    openai_service,
    r2_service,
    reply_tracker_service,
    vector_store,
)

router = APIRouter(prefix="/api/emails", tags=["emails"])


# ── Request / Response models ────────────────────────────────────────────────

class FetchRequest(BaseModel):
    oauth_token: str                  # Google OAuth2 access token
    sender: str = ""                  # Optional sender filter (e.g. "john@example.com")
    days: int | None = None        # Optional count of days filter (e.g. 7, 30)
    start_date: str | None = None  # Optional YYYY-MM-DD start date
    end_date: str | None = None    # Optional YYYY-MM-DD end date
    max_results: int = 20


class SummarizeRequest(BaseModel):
    oauth_token: str
    message_ids: list[str]
    force: bool = False   # Set True to overwrite & re-summarize


class SendEmailRequest(BaseModel):
    oauth_token: str
    to: str
    subject: str
    body: str


class DeleteSummaryRequest(BaseModel):
    message_id: str


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/delete_summary")
@router.delete("/summary/{message_id:path}")
async def delete_summary_route(
    body: DeleteSummaryRequest | None = None,
    message_id: str | None = None,
    user: dict = Depends(get_current_user),
):
    """
    Delete a stored summary from vector store and metadata by message_id or doc_id.
    """
    target_id = body.message_id if body and body.message_id else message_id
    if not target_id:
        raise HTTPException(status_code=400, detail="message_id is required")

    print(f"[Terminal Log] [Delete] Action: Delete Summary for ID '{target_id}' requested by {user.get('email')}")
    removed = vector_store.delete_document(target_id)
    uid = user.get("uid", "")
    email_addr = user.get("email") or ""
    if not removed:
        print(f"[Terminal Log] [Warning] Summary '{target_id}' not found in vector store")
        log_service.add_log(uid, email_addr, "DELETE_SUMMARY", f"Failed to delete summary (ID: {target_id}). Summary not found.", "ERROR")
        raise HTTPException(status_code=404, detail="Summary not found")
    print(f"[Terminal Log] [Success] Summary '{target_id}' deleted from vector store & metadata index rebuilt.")
    log_service.add_log(uid, email_addr, "DELETE_SUMMARY", f"Deleted summary (ID: {target_id}) from vector store.", "SUCCESS")
    return {"status": "deleted", "message_id": target_id}


@router.post("/send")
async def send_email_route(
    oauth_token: str = Form(...),
    to: str = Form(...),
    subject: str = Form(...),
    body: str = Form(...),
    attachments: list[UploadFile] = File(None),
    user: dict = Depends(get_current_user),
):
    """
    Send an email from the user's Gmail account supporting text and file attachments.
    """
    uid = user.get("uid", "")
    email_addr = user.get("email") or ""
    if not to or not subject:
        raise HTTPException(status_code=400, detail="Recipient email and subject are required.")

    # Process attachments & optionally archive to Cloudflare R2
    mime_attachments = []
    if attachments:
        for file in attachments:
            try:
                content = await file.read()
                # Check if it is a valid file
                if file.filename:
                    mime_attachments.append((file.filename, content, file.content_type))
                    try:
                        key = r2_service.upload_file_bytes(
                            uid=uid,
                            filename=file.filename,
                            file_bytes=content,
                            content_type=file.content_type or "application/octet-stream",
                            subfolder="outgoing"
                        )
                        r2_service.record_document_metadata(
                            uid=uid,
                            key=key,
                            filename=file.filename,
                            direction="outgoing",
                            associated_email=to,
                            subject=subject,
                            size_bytes=len(content),
                            content_type=file.content_type or "application/octet-stream"
                        )
                    except Exception as r2_err:
                        print(f"[R2Storage] Outgoing upload failed for {file.filename}: {r2_err}")
            except Exception as fe:
                print(f"[SendEmailError] Failed to read attachment {file.filename}: {fe}")

    try:
        # Check user profile from MongoDB to replace [Sender] in body
        from db import profiles_collection
        user_prof = profiles_collection.find_one({"uid": uid}, {"_id": 0})
        if user_prof:
            sig = []
            if user_prof.get("name"):
                sig.append(user_prof["name"])
            if user_prof.get("designation"):
                sig.append(user_prof["designation"])
            if user_prof.get("company_name"):
                sig.append(user_prof["company_name"])
            if user_prof.get("phone_number"):
                sig.append(user_prof["phone_number"])

            signature_str = "\n".join(sig)
            if "[Sender]" in body:
                body = body.replace("[Sender]", signature_str)
            else:
                body = body + "\n\n" + signature_str
    except Exception:
        pass

    try:
        res = await gmail_service.send_email(
            access_token=oauth_token,
            to=to,
            subject=subject,
            body=body,
            attachments=mime_attachments,
        )
        thread_id = res.get("threadId", "")
        if thread_id:
            reply_tracker_service.track_thread(uid, thread_id, to, subject)
        log_service.add_log(uid, email_addr, "FORWARD_EMAIL", f"Forwarded email summary to '{to}' with subject '{subject}' ({len(mime_attachments)} attachments).", "SUCCESS")
        return {"status": "sent", "message_id": res.get("id", ""), "thread_id": thread_id}
    except Exception as e:
        log_service.add_log(uid, email_addr, "FORWARD_EMAIL", f"Failed to forward email summary to '{to}': {e!s}", "ERROR")
        raise HTTPException(status_code=502, detail=f"Failed to send email via Gmail API: {e}")


@router.post("/fetch")
async def fetch_emails(
    body: FetchRequest,
    user: dict = Depends(get_current_user),
):
    """
    Fetch emails from the user's Gmail account.
    Optionally filter by sender address, days count, or date range.
    Returns a list of parsed email dicts (without full body to keep response small).
    """
    print(f"[Terminal Log] [Fetch] Action: Fetch emails requested by {user.get('email')} (sender='{body.sender}', days={body.days})")
    uid = user.get("uid", "")
    try:
        emails = await gmail_service.fetch_emails_with_content(
            access_token=body.oauth_token,
            sender=body.sender,
            days=body.days,
            start_date=body.start_date,
            end_date=body.end_date,
            max_results=body.max_results,
        )
    except Exception as e:
        print(f"[Terminal Log] [Error] Error fetching emails: {e}")
        raise HTTPException(status_code=502, detail=f"Gmail API error: {e}")

    # Attach existing summaries from vector store
    all_summaries = vector_store.get_all_summaries(uid=uid)
    user_summaries = {s["message_id"]: s.get("summary", "") for s in all_summaries}
    print(f"[Terminal Log] [Success] Fetched {len(emails)} emails ({len(user_summaries)} already summarized).")

    # Record fetch activity in MongoDB logs
    log_service.add_log(
        uid=uid,
        email=user.get("email") or "",
        action="FETCH_EMAILS",
        details=f"Fetched {len(emails)} emails from Gmail inbox ({len(user_summaries)} summarized).",
        status="SUCCESS"
    )

    # Return email list with full body for modal preview
    return {
        "emails": [
            {
                "id":      e["id"],
                "from":    e["from"],
                "subject": e["subject"],
                "date":    e["date"],
                "snippet": e["snippet"],
                "body":    e["body"],
                "is_summarized": e["id"] in user_summaries,
                "summary": user_summaries.get(e["id"], ""),
            }
            for e in emails
        ]
    }


@router.post("/summarize")
async def summarize_emails(
    body: SummarizeRequest,
    user: dict = Depends(get_current_user),
):
    """
    For each message_id:
    1. Fetch full email content from Gmail.
    2. Summarize with GPT-4o-mini.
    3. Store document with integrated embeddings in vector store.
    Returns per-message results.
    """
    print(f"[Terminal Log] [Summarize] Action: Summarize {len(body.message_ids)} emails requested by {user.get('email')} (force={body.force})")
    results = []

    uid = user.get("uid", "")

    for msg_id in body.message_ids:
        # Delete old summary if force=True
        if body.force and vector_store.is_already_stored(msg_id, uid=uid):
            vector_store.delete_document(msg_id, uid=uid)

        # Skip if already stored (only when force=False)
        if not body.force and vector_store.is_already_stored(msg_id, uid=uid):
            existing = next(
                (m for m in vector_store.get_all_summaries(uid=uid) if m["message_id"] == msg_id),
                None,
            )
            results.append({
                "message_id": msg_id,
                "summary":    existing["summary"] if existing else "",
                "status":     "already_stored",
            })
            continue

        try:
            raw     = await gmail_service.get_full_message(body.oauth_token, msg_id)
            email   = gmail_service.extract_email_content(raw)
            summary = await openai_service.summarize_email(email["body"], email["subject"])

            # If subject is missing or "(No subject)", auto-generate an intelligent title from content
            effective_subject = (email["subject"] or "").strip()
            if not effective_subject or effective_subject.lower() in ("no subject", "(no subject)", "untitled"):
                effective_subject = await openai_service.generate_subject_from_content(email["body"], summary)

            vector_store.add_document({
                "message_id": msg_id,
                "subject":    effective_subject,
                "from":       email["from"],
                "date":       email["date"],
                "summary":    summary,
                "uid":        user.get("uid", ""),
            })

            # Extract graph entities & update Knowledge Graph
            try:
                entities = await openai_service.extract_graph_entities(
                    subject=effective_subject,
                    summary=summary,
                    body=email["body"]
                )
                graph_service.add_email_to_graph(
                    message_id=msg_id,
                    subject=effective_subject,
                    sender_raw=email["from"],
                    date=email["date"],
                    summary=summary,
                    uid=user.get("uid", ""),
                    extracted_entities=entities
                )
            except Exception as ge:
                print(f"[GraphError] {ge}")

            log_service.add_log(
                uid=user.get("uid", ""),
                email=user.get("email") or "",
                action="SUMMARIZE_SINGLE",
                details=f"Summarized email from '{email['from']}' (Subject: '{effective_subject}').",
                status="SUCCESS"
            )

            results.append({
                "message_id": msg_id,
                "summary":    summary,
                "subject":    effective_subject,
                "status":     "stored",
            })
        except Exception as e:
            log_service.add_log(
                uid=user.get("uid", ""),
                email=user.get("email") or "",
                action="SUMMARIZE_SINGLE",
                details=f"Failed to summarize email ID {msg_id}: {e!s}",
                status="ERROR"
            )
            results.append({
                "message_id": msg_id,
                "summary":    "",
                "status":     f"error: {e}",
            })

    return {"results": results}


@router.post("/summarize_club")
async def summarize_email_club(
    body: SummarizeRequest,
    user: dict = Depends(get_current_user),
):
    """
    Summarize a club/group of multiple message_ids together into a single executive summary.
    Stores the single combined summary and maps it in the Knowledge Graph.
    """
    if not body.message_ids:
        raise HTTPException(status_code=400, detail="No message IDs provided to club.")

    fetched_emails = []
    subjects = []
    senders = set()
    latest_date = ""

    for msg_id in body.message_ids:
        try:
            raw = await gmail_service.get_full_message(body.oauth_token, msg_id)
            email = gmail_service.extract_email_content(raw)
            fetched_emails.append(email)
            if email.get("subject"):
                subjects.append(email["subject"])
            if email.get("from"):
                senders.add(email["from"])
            if email.get("date"):
                latest_date = email["date"]
        except Exception as e:
            print(f"[ClubFetchError] Failed to fetch message {msg_id}: {e}")

    if not fetched_emails:
        raise HTTPException(status_code=502, detail="Failed to fetch any of the requested emails.")

    # Joint summary using LLM
    summary = await openai_service.summarize_email_club(fetched_emails)

    # Consolidated club ID & subject
    club_id = f"club_{'_'.join(body.message_ids[:3])}"
    count = len(fetched_emails)
    first_subj = subjects[0] if subjects else "Clubbed Thread"
    consolidated_subject = f"✦ [Thread Summary - {count} Emails] {first_subj}"
    combined_from = ", ".join(list(senders)[:2]) + (f" (+{len(senders)-2} more)" if len(senders) > 2 else "")

    # Store in vector store
    uid = user.get("uid", "")
    vector_store.add_document({
        "message_id": club_id,
        "message_ids": body.message_ids,
        "subject": consolidated_subject,
        "from": combined_from,
        "date": latest_date,
        "summary": summary,
        "email_count": count,
        "is_clubbed": True,
        "uid": uid,
    })

    # Update Knowledge Graph
    try:
        entities = await openai_service.extract_graph_entities(
            subject=consolidated_subject,
            summary=summary,
            body="\n".join([e.get("body", "")[:300] for e in fetched_emails])
        )
        graph_service.add_email_to_graph(
            message_id=club_id,
            subject=consolidated_subject,
            sender_raw=combined_from,
            date=latest_date,
            summary=summary,
            uid=uid,
            extracted_entities=entities
        )
    except Exception as ge:
        print(f"[GraphError] {ge}")

    log_service.add_log(
        uid=uid,
        email=user.get("email") or "",
        action="SUMMARIZE_CLUB",
        details=f"Summarized clubbed thread of {count} emails (Subject: '{consolidated_subject}').",
        status="SUCCESS"
    )

    return {
        "status": "stored",
        "club_id": club_id,
        "email_count": count,
        "message_ids": body.message_ids,
        "summary": summary,
        "subject": consolidated_subject,
    }


@router.get("/summaries")
async def get_summaries(user: dict = Depends(get_current_user)):
    """
    Return all stored email summaries from Pinecone.
    Filtered by the requesting user's UID namespace.
    """
    uid = user.get("uid", "")
    user_summaries = vector_store.get_all_summaries(uid=uid)
    return {"summaries": user_summaries}


class CheckRepliesRequest(BaseModel):
    oauth_token: str

class DismissReplyRequest(BaseModel):
    thread_id: str

@router.post("/replies")
async def check_replies_route(
    body: CheckRepliesRequest,
    user: dict = Depends(get_current_user)
):
    """
    Check for new incoming replies on all tracked threads.
    """
    uid = user.get("uid", "")
    email = user.get("email", "")
    alerts = await reply_tracker_service.check_for_replies(body.oauth_token, uid, email)
    return {"alerts": alerts}

@router.post("/replies/dismiss")
async def dismiss_reply_route(
    body: DismissReplyRequest,
    user: dict = Depends(get_current_user)
):
    """
    Dismiss a reply alert for a specific thread.
    """
    uid = user.get("uid", "")
    success = reply_tracker_service.dismiss_thread(uid, body.thread_id)
    if not success:
        raise HTTPException(status_code=404, detail="Tracked thread not found or already dismissed.")
    return {"status": "dismissed"}


class GetThreadRequest(BaseModel):
    oauth_token: str
    thread_id: str

@router.post("/thread")
async def get_thread_route(
    body: GetThreadRequest,
    user: dict = Depends(get_current_user)
):
    """
    Retrieve and parse all messages in a specific email thread.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"https://gmail.googleapis.com/gmail/v1/users/me/threads/{body.thread_id}",
            headers={"Authorization": f"Bearer {body.oauth_token}"},
            timeout=15
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail="Failed to fetch thread from Gmail.")
        thread_data = resp.json()
        messages = thread_data.get("messages", [])
        
        parsed_messages = []
        for msg in messages:
            parsed = gmail_service.extract_email_content(msg)
            parsed_messages.append(parsed)
            
        return {"messages": parsed_messages}


SCRATCHPAD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "scratchpads")

class ScratchpadRequest(BaseModel):
    content: str

@router.get("/scratchpad")
async def get_scratchpad(user: dict = Depends(get_current_user)):
    """
    Load scratchpad content for the current user.
    """
    uid = user.get("uid", "")
    filepath = os.path.join(SCRATCHPAD_DIR, f"{uid}.txt")
    content = ""
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                content = f.read()
        except Exception as e:
            print(f"[Scratchpad] Failed to read note: {e}")
    return {"content": content}

@router.post("/scratchpad")
async def save_scratchpad(body: ScratchpadRequest, user: dict = Depends(get_current_user)):
    """
    Save scratchpad content for the current user.
    """
    uid = user.get("uid", "")
    os.makedirs(SCRATCHPAD_DIR, exist_ok=True)
    filepath = os.path.join(SCRATCHPAD_DIR, f"{uid}.txt")
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(body.content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save scratchpad: {e}")
    return {"status": "saved"}


@router.get("/attachment/{message_id}/{attachment_id}")
async def get_attachment_route(
    message_id: str,
    attachment_id: str,
    filename: str,
    oauth_token: str,
    inline: bool = True,
    sender: str = "",
    subject: str = "",
    user: dict = Depends(get_current_user)
):
    """
    Fetch and decode an attachment by ID from Gmail API, and cache/archive to Cloudflare R2.
    Supports inline=True for direct in-browser viewing/previewing without downloading.
    """
    uid = user.get("uid", "")
    
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{message_id}/attachments/{attachment_id}",
            headers={"Authorization": f"Bearer {oauth_token}"},
            timeout=20
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail="Failed to fetch attachment from Gmail.")
        
        data = resp.json()
        raw_data = data.get("data", "")
        
        # Decode base64url encoded attachment payload
        file_bytes = base64.urlsafe_b64decode(raw_data)
        
        # Detect proper MIME type from filename
        import mimetypes
        guessed_type, _ = mimetypes.guess_type(filename)
        mime_type = guessed_type or "application/octet-stream"

        # Archive copy to Cloudflare R2 under user namespace with proper content_type
        try:
            key = r2_service.upload_file_bytes(
                uid=uid,
                filename=f"{message_id}_{filename}",
                file_bytes=file_bytes,
                content_type=mime_type,
                subfolder="incoming"
            )
            r2_service.record_document_metadata(
                uid=uid,
                key=key,
                filename=filename,
                direction="incoming",
                associated_email=sender,
                subject=subject,
                size_bytes=len(file_bytes),
                content_type=mime_type,
                message_id=message_id
            )
        except Exception as r2_err:
            print(f"[R2Storage] Incoming attachment archive failed: {r2_err}")
        
        disposition = "inline" if inline else "attachment"
        return Response(
            content=file_bytes,
            media_type=mime_type,
            headers={"Content-Disposition": f'{disposition}; filename="{filename}"'}
        )


@router.get("/documents")
async def get_r2_documents(
    direction: str = "all",
    email_filter: str = "",
    user: dict = Depends(get_current_user)
):
    """
    List all documents stored in Cloudflare R2 for the user,
    filtered by direction ('all', 'incoming', 'outgoing') and associated email.
    """
    uid = user.get("uid", "")
    try:
        docs = r2_service.list_user_documents(
            uid=uid,
            direction=direction,
            email_filter=email_filter
        )
        return {"documents": docs, "total": len(docs)}
    except Exception as e:
        print(f"[R2Error] Failed to list documents: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to list documents: {e}")


@router.delete("/documents")
async def delete_r2_document(
    key: str = Body(..., embed=True),
    user: dict = Depends(get_current_user)
):
    """
    Delete a document from Cloudflare R2 and the MongoDB ledger.
    """
    uid = user.get("uid", "")
    try:
        r2_service.delete_user_document(uid=uid, key=key)
        return {"status": "deleted", "key": key}
    except PermissionError as pe:
        raise HTTPException(status_code=403, detail=str(pe))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete document: {e}")


class SyncAttachmentsRequest(BaseModel):
    oauth_token: str
    max_emails: int = 30


@router.post("/documents/sync_inbox")
async def sync_inbox_attachments(
    body: SyncAttachmentsRequest,
    user: dict = Depends(get_current_user)
):
    """
    Scan recent inbox emails for attachments, download them from Gmail,
    and archive them directly to Cloudflare R2 under users/{uid}/incoming/.
    """
    uid = user.get("uid", "")
    synced_count = 0
    try:
        messages_meta = gmail_service.fetch_inbox_messages(body.oauth_token, max_results=body.max_emails)
        for meta in messages_meta:
            msg_id = meta.get("id")
            if not msg_id:
                continue
            try:
                raw_msg = gmail_service.fetch_full_message(body.oauth_token, msg_id)
                parsed = gmail_service.extract_email_content(raw_msg)
                sender = parsed.get("from", "")
                subject = parsed.get("subject", "")
                attachments = parsed.get("attachments", [])

                for att in attachments:
                    att_id = att.get("attachmentId")
                    att_name = att.get("filename")
                    att_size = att.get("size", 0)
                    if not att_id or not att_name:
                        continue

                    r2_key = f"users/{uid}/incoming/{msg_id}_{att_name}"

                    async with httpx.AsyncClient() as client:
                        resp = await client.get(
                            f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{msg_id}/attachments/{att_id}",
                            headers={"Authorization": f"Bearer {body.oauth_token}"},
                            timeout=20
                        )
                        if resp.status_code == 200:
                            raw_b64 = resp.json().get("data", "")
                            f_bytes = base64.urlsafe_b64decode(raw_b64)
                            r2_service.upload_file_bytes(
                                uid=uid,
                                filename=f"{msg_id}_{att_name}",
                                file_bytes=f_bytes,
                                content_type=att.get("mimeType", "application/octet-stream"),
                                subfolder="incoming"
                            )
                            r2_service.record_document_metadata(
                                uid=uid,
                                key=r2_key,
                                filename=att_name,
                                direction="incoming",
                                associated_email=sender,
                                subject=subject,
                                size_bytes=len(f_bytes) or att_size,
                                content_type=att.get("mimeType", "application/octet-stream"),
                                message_id=msg_id
                            )
                            synced_count += 1
            except Exception as e_inner:
                print(f"[SyncError] Error on message {msg_id}: {e_inner}")

        return {"status": "success", "synced": synced_count}
    except Exception as e:
        print(f"[R2SyncError] Failed to sync attachments: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to sync attachments: {e}")


@router.get("/calendar")
async def get_calendar_events(user: dict = Depends(get_current_user)):
    """
    Fetch user-specific calendar events array.
    """
    uid = user["uid"]
    calendar_dir = "server/data/calendar"
    os.makedirs(calendar_dir, exist_ok=True)
    file_path = os.path.join(calendar_dir, f"{uid}.json")
    if not os.path.exists(file_path):
        return []
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


@router.post("/calendar")
async def save_calendar_events(events: list = Body(...), user: dict = Depends(get_current_user)):
    """
    Overwrite user-specific calendar events.
    """
    uid = user["uid"]
    calendar_dir = "server/data/calendar"
    os.makedirs(calendar_dir, exist_ok=True)
    file_path = os.path.join(calendar_dir, f"{uid}.json")
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(events, f, ensure_ascii=False, indent=2)
        return {"status": "saved"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save calendar: {e}")


class EmailDraftRequest(BaseModel):
    persona: str
    product_description: str
    recipient_email: str | None = None
    additional_context: str | None = None


@router.post("/draft")
async def generate_draft(body: EmailDraftRequest, user: dict = Depends(get_current_user)):
    """
    Draft a custom persona-based email.
    """
    try:
        draft = await openai_service.draft_persona_email(
            persona=body.persona,
            product_description=body.product_description,
            additional_context=body.additional_context or "",
            recipient_email=body.recipient_email or ""
        )
        
        # Load user profile from MongoDB if exists and replace [Sender] in body
        from db import profiles_collection
        uid = user.get("uid", "")
        user_prof = profiles_collection.find_one({"uid": uid}, {"_id": 0})
        if user_prof:
            sig = []
            if user_prof.get("name"):
                sig.append(user_prof["name"])
            if user_prof.get("designation"):
                sig.append(user_prof["designation"])
            if user_prof.get("company_name"):
                sig.append(user_prof["company_name"])
            if user_prof.get("phone_number"):
                sig.append(user_prof["phone_number"])

            signature_str = "\n".join(sig)
            if "body" in draft and "[Sender]" in draft["body"]:
                draft["body"] = draft["body"].replace("[Sender]", signature_str)
            elif "body" in draft:
                draft["body"] = draft["body"] + "\n\n" + signature_str

        return {"status": "success", "draft": draft}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Drafting failed: {e}")
