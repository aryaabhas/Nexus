"""
Gmail API service — fetch, parse, and decode emails.
All calls are made with the user's OAuth2 access token (client-side Google token).
"""

import base64
import html
import re

from fastapi import HTTPException
import httpx

GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"


async def list_messages(
    access_token: str,
    sender: str = "",
    days: int | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    max_results: int = 20,
) -> list[dict]:
    """
    List Gmail messages, optionally filtered by sender, count of days, or date range.
    Returns a list of {id, threadId} dicts.
    """
    query_parts = []
    if sender:
        query_parts.append(f"from:{sender}")
    if days:
        query_parts.append(f"newer_than:{days}d")
    if start_date:
        query_parts.append(f"after:{start_date.replace('-', '/')}")
    if end_date:
        query_parts.append(f"before:{end_date.replace('-', '/')}")

    query = " ".join(query_parts)
    params = {"maxResults": max_results}
    if query:
        params["q"] = query

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{GMAIL_API_BASE}/messages",
            headers={"Authorization": f"Bearer {access_token}"},
            params=params,
            timeout=20,
        )
    resp.raise_for_status()
    data = resp.json()
    return data.get("messages", [])


async def get_full_message(access_token: str, message_id: str) -> dict:
    """
    Fetch the full message payload for a given message ID.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{GMAIL_API_BASE}/messages/{message_id}",
            headers={"Authorization": f"Bearer {access_token}"},
            params={"format": "full"},
            timeout=20,
        )
    resp.raise_for_status()
    return resp.json()


def _decode_base64url(data: str) -> str:
    """Decode a Base64URL-encoded string to UTF-8 text."""
    # Gmail uses URL-safe base64 (- instead of +, _ instead of /)
    padded = data.replace("-", "+").replace("_", "/")
    # Pad to multiple of 4
    padded += "=" * (4 - len(padded) % 4)
    try:
        return base64.b64decode(padded).decode("utf-8", errors="replace")
    except Exception:
        return ""


def _extract_body(payload: dict) -> str:
    """
    Recursively extract plain-text body from a Gmail message payload.
    Handles multipart/alternative and nested MIME structures.
    """
    mime_type = payload.get("mimeType", "")
    body_data = payload.get("body", {}).get("data", "")

    if mime_type == "text/plain" and body_data:
        return _decode_base64url(body_data)

    if mime_type == "text/html" and body_data:
        html = _decode_base64url(body_data)
        # Strip HTML tags for plain text
        return re.sub(r"<[^>]+>", " ", html)

    parts = payload.get("parts", [])
    # Prefer text/plain parts first
    for part in parts:
        if part.get("mimeType") == "text/plain":
            text = _extract_body(part)
            if text.strip():
                return text
    # Fallback: try all parts recursively
    for part in parts:
        text = _extract_body(part)
        if text.strip():
            return text

    return ""


def _get_header(headers: list[dict], name: str) -> str:
    """Extract a header value by name (case-insensitive)."""
    for h in headers:
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def _clean_text(text: str, max_chars: int = 3000) -> str:
    """
    Strip excessive whitespace and truncate to max_chars to minimise
    tokens sent to GPT-4o-mini.
    """
    text = re.sub(r"\s{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()[:max_chars]


def _extract_attachments(parts: list) -> list:
    attachments = []
    if not parts:
        return attachments
    for part in parts:
        filename = part.get("filename", "")
        body = part.get("body", {})
        attachment_id = body.get("attachmentId", "")
        mime_type = part.get("mimeType", "")
        size = body.get("size", 0)
        
        if filename and attachment_id:
            attachments.append({
                "filename": filename,
                "attachmentId": attachment_id,
                "mimeType": mime_type,
                "size": size
            })
            
        if "parts" in part:
            attachments.extend(_extract_attachments(part["parts"]))
    return attachments


def extract_email_content(raw_message: dict) -> dict:
    """
    Parse a raw Gmail message dict into a clean content dict:
    {id, from, to, subject, date, snippet, body, attachments}
    """
    payload  = raw_message.get("payload", {})
    headers  = payload.get("headers", [])

    body_raw = _extract_body(payload)
    body     = _clean_text(body_raw)
    
    parts = payload.get("parts", [])
    attachments = _extract_attachments(parts)

    return {
        "id":      raw_message.get("id", ""),
        "from":    html.unescape(_get_header(headers, "From")),
        "to":      html.unescape(_get_header(headers, "To")),
        "subject": html.unescape(_get_header(headers, "Subject")),
        "date":    _get_header(headers, "Date"),
        "snippet": html.unescape(raw_message.get("snippet", "")),
        "body":    html.unescape(body),
        "attachments": attachments
    }


async def fetch_emails_with_content(
    access_token: str,
    sender: str = "",
    days: int | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    max_results: int = 20,
) -> list[dict]:
    """
    Convenience function: list messages then fetch and parse each one.
    Returns list of extracted email content dicts.
    """
    message_refs = await list_messages(
        access_token=access_token,
        sender=sender,
        days=days,
        start_date=start_date,
        end_date=end_date,
        max_results=max_results,
    )
    emails = []
    for ref in message_refs:
        try:
            raw = await get_full_message(access_token, ref["id"])
            emails.append(extract_email_content(raw))
        except Exception:
            # Skip individual failures gracefully
            continue
    return emails


async def send_email(
    access_token: str,
    to: str,
    subject: str,
    body: str,
    from_addr: str = "",
    attachments: list[tuple[str, bytes, str]] = None,
) -> dict:
    """
    Send an email via Gmail API using RFC 5322 MIME format with proper CRLF line
    endings and unpadded base64url encoding, supporting file attachments.
    attachments: list of tuples (filename, content_bytes, content_type)
    """
    from email.message import EmailMessage
    from email.policy import SMTP

    # Resolve sender address if not explicitly passed
    sender = from_addr.strip() if from_addr else ""
    if not sender or "@" not in sender:
        try:
            async with httpx.AsyncClient() as client:
                prof_resp = await client.get(
                    f"{GMAIL_API_BASE}/profile",
                    headers={"Authorization": f"Bearer {access_token}"},
                    timeout=10,
                )
                if prof_resp.status_code == 200:
                    sender = prof_resp.json().get("emailAddress", "")
        except Exception as pe:
            print(f"[GmailService] Could not resolve user profile email: {pe}")

    msg = EmailMessage(policy=SMTP)
    msg["To"] = to.strip()
    msg["Subject"] = subject.strip()
    if sender:
        msg["From"] = sender
    else:
        msg["From"] = "me"

    msg.set_content(body or "")

    # Add attachments if any
    if attachments:
        for filename, content, content_type in attachments:
            if not content:
                continue
            mimetype = content_type or "application/octet-stream"
            if "/" in mimetype:
                maintype, subtype = mimetype.split("/", 1)
            else:
                maintype, subtype = "application", "octet-stream"
            try:
                msg.add_attachment(
                    content,
                    maintype=maintype,
                    subtype=subtype,
                    filename=filename,
                )
            except Exception as e:
                print(f"[GmailServiceError] Failed to attach file {filename}: {e}")

    # RFC 2822 bytes with standard CRLF (\r\n) line terminators
    raw_bytes = msg.as_bytes()
    # Gmail API requires URL-safe base64 with stripped '=' padding
    encoded_message = base64.urlsafe_b64encode(raw_bytes).rstrip(b"=").decode("utf-8")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{GMAIL_API_BASE}/messages/send",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            json={"raw": encoded_message},
            timeout=25,
        )

    if resp.status_code != 200:
        err_detail = resp.text
        try:
            err_json = resp.json()
            err_detail = err_json.get("error", {}).get("message", resp.text)
        except Exception:
            pass
        print(f"[GmailSendError] Gmail API responded with status {resp.status_code}: {resp.text}")
        raise HTTPException(
            status_code=resp.status_code,
            detail=f"Gmail API error ({resp.status_code}): {err_detail}",
        )

    return resp.json()
