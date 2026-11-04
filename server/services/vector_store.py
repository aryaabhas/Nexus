"""
Vector store service — Pinecone ONLY for email summaries & semantic search.

Features:
- Embeddings handled natively by Pinecone Cloud (0 local RAM footprint).
- Strict multi-tenant user isolation using Pinecone namespaces (`namespace=uid`).
- NO MongoDB caching for email summaries — Pinecone is the single source of truth.
"""

import os
import traceback
from dotenv import load_dotenv
from pinecone import Pinecone

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

PINECONE_API_KEY = os.getenv("PINECONE_API_KEY")
INDEX_NAME = os.getenv("PINECONE_INDEX_NAME", "nexus-emails")

_pc = None
_index = None

def _get_index():
    global _pc, _index
    if _index is None:
        _pc = Pinecone(api_key=PINECONE_API_KEY)
        _index = _pc.Index(INDEX_NAME)
    return _index

def load_store() -> None:
    """Initialize connection to Pinecone at startup."""
    try:
        idx = _get_index()
        print(f"[VectorStore] Connected to Pinecone index: '{INDEX_NAME}'.")
    except Exception as e:
        print(f"[VectorStore] Error connecting to Pinecone: {e}")

def _extract_fields_from_doc(doc, fallback_id: str | None = None) -> dict:
    """Helper to reliably extract subject, summary, from, date, etc. from a Pinecone Document."""
    doc_id = fallback_id or getattr(doc, "id", None) or getattr(doc, "_id", None)
    doc_dict = doc.to_dict() if hasattr(doc, "to_dict") else {}
    if not doc_dict and hasattr(doc, "fields"):
        doc_dict = getattr(doc, "fields", {}) or {}

    subject = (
        doc_dict.get("subject")
        or doc_dict.get("title")
        or getattr(doc, "subject", "")
        or getattr(doc, "title", "")
    )
    summary = (
        doc_dict.get("summary")
        or getattr(doc, "summary", "")
        or ""
    )
    sender = (
        doc_dict.get("from")
        or getattr(doc, "from", "")
        or ""
    )
    date = (
        doc_dict.get("date")
        or getattr(doc, "date", "")
        or ""
    )
    is_clubbed = bool(doc_dict.get("is_clubbed") or getattr(doc, "is_clubbed", False))
    email_count = doc_dict.get("email_count") or getattr(doc, "email_count", 1)

    # Smart fallback from chunk_text if any fields were not stored separately in legacy docs
    chunk_text = doc_dict.get("chunk_text") or getattr(doc, "chunk_text", "")
    if chunk_text:
        if not summary:
            if "Summary:" in chunk_text:
                summary = chunk_text.split("Summary:", 1)[1].strip()
            else:
                summary = chunk_text
        if not sender:
            for line in chunk_text.splitlines():
                if line.startswith("From:"):
                    sender = line.replace("From:", "").strip()
                    break
        if not date:
            for line in chunk_text.splitlines():
                if line.startswith("Date:"):
                    date = line.replace("Date:", "").strip()
                    break
        if not subject or subject.lower() in ("no subject", "(no subject)", "untitled"):
            for line in chunk_text.splitlines():
                if line.startswith("Subject:"):
                    cand = line.replace("Subject:", "").strip()
                    if cand and cand.lower() not in ("no subject", "(no subject)"):
                        subject = cand
                    break

    if not subject:
        subject = "No Subject"

    return {
        "message_id": str(doc_id) if doc_id else "",
        "doc_id": str(doc_id) if doc_id else "",
        "subject": subject,
        "summary": summary,
        "from": sender,
        "date": date,
        "is_clubbed": is_clubbed,
        "email_count": email_count,
    }

def add_document(metadata: dict) -> str:
    """
    Store an email document exclusively in Pinecone under the user's isolated namespace.
    """
    idx = _get_index()
    doc_id = metadata.get("message_id") or metadata.get("doc_id")
    uid = metadata.get("uid") or "default_user"
    
    title = metadata.get("subject", "No Subject")
    summary = metadata.get("summary", "")
    sender = metadata.get("from", "")
    date = metadata.get("date", "")
    is_clubbed = bool(metadata.get("is_clubbed", False))
    email_count = metadata.get("email_count", 1)

    chunk_text = f"From: {sender}\nDate: {date}\nSubject: {title}\nSummary: {summary}"

    # Upsert document into Pinecone with full metadata fields
    doc_payload = {
        "_id": doc_id,
        "title": title,
        "chunk_text": chunk_text,
        "subject": title,
        "summary": summary,
        "from": sender,
        "date": date,
        "message_id": doc_id,
        "uid": uid,
        "is_clubbed": is_clubbed,
        "email_count": email_count
    }

    try:
        res = idx.documents.upsert(
            namespace=uid,
            documents=[doc_payload]
        )
        print(f"[VectorStore] Successfully upserted doc '{doc_id}' to Pinecone namespace '{uid}': {res}")
    except Exception as e:
        print(f"[VectorStore] documents.upsert notice: {e}, falling back to upsert_records...")
        try:
            res = idx.upsert_records(
                namespace=uid or "__default__",
                records=[doc_payload]
            )
            print(f"[VectorStore] Successfully upserted doc via fallback (upsert_records): {res}")
        except Exception as e2:
            print(f"[VectorStore] Fallback upsert_records error: {e2}")

    return doc_id

def search(query_text: str, uid: str = "default_user", k: int = 5) -> list[dict]:
    """
    Search documents within the user's isolated Pinecone namespace using integrated search.
    Reads fields directly from Pinecone.
    """
    idx = _get_index()
    matches = []

    # 1. Try Documents API (Document-based Index)
    try:
        response = idx.documents.search(
            namespace=uid,
            top_k=k,
            score_by=[{
                "type": "embed",
                "field": "chunk_text",
                "query": query_text
            }],
            include_fields=["*"]
        )
        matches = getattr(response, "matches", []) or []
    except Exception as e:
        print(f"[VectorStore] Notice on documents.search (include_fields='*'): {e}")
        try:
            # Fallback to explicit fields list
            response = idx.documents.search(
                namespace=uid,
                top_k=k,
                score_by=[{
                    "type": "embed",
                    "field": "chunk_text",
                    "query": query_text
                }],
                include_fields=["title", "chunk_text", "summary", "subject", "from", "date", "message_id", "is_clubbed", "email_count"]
            )
            matches = getattr(response, "matches", []) or []
        except Exception as e_docs:
            print(f"[VectorStore] Notice on documents.search with explicit fields: {e_docs}")
            # 2. Try Records Search API (Integrated Index)
            try:
                resp = idx.search(
                    namespace=uid or "__default__",
                    top_k=k,
                    inputs={"text": query_text},
                    fields=["title", "chunk_text", "summary", "subject", "from", "date", "message_id"]
                )
                matches = getattr(getattr(resp, "result", None), "hits", []) or []
            except Exception as e2:
                print(f"[VectorStore] Pinecone search error: {e2}")

    results = []
    for match in matches:
        score = float(getattr(match, "score", 0.0) or 0.0)
        extracted = _extract_fields_from_doc(match)
        extracted["score"] = score
        results.append(extracted)

    return results

def get_all_summaries(uid: str | None = None) -> list[dict]:
    """
    Fetch all stored email summaries directly from Pinecone for the user's namespace.
    Uses Documents API (/namespaces/{namespace}/documents/list and /fetch).
    """
    idx = _get_index()
    namespace = uid or "default_user"
    summaries = []

    try:
        doc_ids = []
        # Paginate through documents.list
        try:
            for item in idx.documents.list(namespace=namespace):
                doc_id = getattr(item, "_id", None) or getattr(item, "id", None)
                if doc_id:
                    doc_ids.append(str(doc_id))
        except Exception as e:
            print(f"[VectorStore] Notice on idx.documents.list: {e}")
            traceback.print_exc()

        if not doc_ids:
            return []

        # Fetch in batches of 50
        for i in range(0, len(doc_ids), 50):
            batch = doc_ids[i:i+50]
            try:
                fetched = idx.documents.fetch(namespace=namespace, ids=batch)
                docs = getattr(fetched, "documents", {}) or {}
                for mid, doc in docs.items():
                    extracted = _extract_fields_from_doc(doc, fallback_id=mid)
                    extracted["uid"] = namespace
                    summaries.append(extracted)
            except Exception as fe:
                print(f"[VectorStore] Error fetching batch from idx.documents.fetch: {fe}")
                traceback.print_exc()

    except Exception as e:
        print(f"[VectorStore] Error in get_all_summaries: {e}")
        traceback.print_exc()

    return summaries

def is_already_stored(message_id: str, uid: str | None = None) -> bool:
    """Check if an email is already stored in Pinecone."""
    idx = _get_index()
    namespace = uid or "default_user"
    try:
        res = idx.documents.fetch(namespace=namespace, ids=[message_id])
        docs = getattr(res, "documents", {}) or {}
        return message_id in docs
    except Exception:
        return False

def delete_document(target_id: str, uid: str = "default_user") -> bool:
    """Delete document directly from Pinecone."""
    idx = _get_index()
    try:
        idx.documents.delete(namespace=uid, ids=[target_id])
        return True
    except Exception as e:
        print(f"[VectorStore] Error deleting doc from Pinecone: {e}")
        return False
