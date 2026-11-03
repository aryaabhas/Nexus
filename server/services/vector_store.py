"""
Vector store service — Pinecone ONLY for email summaries & semantic search.

Features:
- Embeddings handled natively by Pinecone Cloud (0 local RAM footprint).
- Strict multi-tenant user isolation using Pinecone namespaces (`namespace=uid`).
- NO MongoDB caching for email summaries — Pinecone is the single source of truth.
"""

import os
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
        "uid": uid
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
        match_id = getattr(match, "id", None) or getattr(match, "_id", None)
        score = float(getattr(match, "score", 0.0))
        fields = getattr(match, "fields", {}) or {}

        subject = fields.get("subject") or fields.get("title") or getattr(match, "title", "No Subject")
        summary = fields.get("summary", "")
        sender = fields.get("from", "")
        date = fields.get("date", "")

        results.append({
            "message_id": match_id,
            "doc_id": match_id,
            "subject": subject,
            "summary": summary,
            "from": sender,
            "date": date,
            "score": score
        })

    return results

def get_all_summaries(uid: str | None = None) -> list[dict]:
    """
    Fetch all stored email summaries directly from Pinecone for the user's namespace.
    """
    idx = _get_index()
    namespace = uid or "default_user"
    summaries = []

    try:
        # List document IDs from Pinecone namespace
        doc_ids = []
        try:
            for item in idx.documents.list(namespace=namespace):
                doc_ids.append(getattr(item, "id", None) or getattr(item, "_id", None))
        except Exception:
            # Fallback to Index.list
            try:
                for id_batch in idx.list(namespace=namespace):
                    doc_ids.extend(id_batch)
            except Exception as e:
                print(f"[VectorStore] Unable to list IDs from Pinecone: {e}")

        if not doc_ids:
            return []

        # Fetch records with fields in batches of 100
        for i in range(0, len(doc_ids), 100):
            batch = [d for d in doc_ids[i:i+100] if d]
            if not batch:
                continue

            try:
                fetched = idx.documents.fetch(namespace=namespace, ids=batch)
                docs = getattr(fetched, "documents", {}) or {}
                for mid, doc in docs.items():
                    summaries.append({
                        "message_id": mid,
                        "doc_id": mid,
                        "subject": getattr(doc, "subject", "") or getattr(doc, "title", "No Subject"),
                        "summary": getattr(doc, "summary", ""),
                        "from": getattr(doc, "from", ""),
                        "date": getattr(doc, "date", ""),
                        "uid": namespace
                    })
            except Exception:
                # Fallback to standard fetch
                try:
                    fetched = idx.fetch(ids=batch, namespace=namespace)
                    vectors = getattr(fetched, "vectors", {}) or {}
                    for mid, vec in vectors.items():
                        meta = getattr(vec, "metadata", {}) or {}
                        summaries.append({
                            "message_id": mid,
                            "doc_id": mid,
                            "subject": meta.get("subject", meta.get("title", "No Subject")),
                            "summary": meta.get("summary", ""),
                            "from": meta.get("from", ""),
                            "date": meta.get("date", ""),
                            "uid": namespace
                        })
                except Exception as fe:
                    print(f"[VectorStore] Fetch batch error from Pinecone: {fe}")

    except Exception as e:
        print(f"[VectorStore] Error fetching summaries from Pinecone: {e}")

    return summaries

def is_already_stored(message_id: str, uid: str | None = None) -> bool:
    """Check if an email is already stored in Pinecone."""
    idx = _get_index()
    namespace = uid or "default_user"
    try:
        res = idx.documents.fetch(namespace=namespace, ids=[message_id])
        docs = getattr(res, "documents", {}) or {}
        if message_id in docs:
            return True
    except Exception:
        pass

    try:
        res = idx.fetch(ids=[message_id], namespace=namespace)
        vectors = getattr(res, "vectors", {}) or {}
        return message_id in vectors
    except Exception:
        return False

def delete_document(target_id: str, uid: str = "default_user") -> bool:
    """Delete document directly from Pinecone."""
    idx = _get_index()
    try:
        idx.documents.delete(namespace=uid, ids=[target_id])
        return True
    except Exception as e:
        print(f"[VectorStore] documents.delete notice: {e}, trying idx.delete...")
        try:
            idx.delete(ids=[target_id], namespace=uid)
            return True
        except Exception as e2:
            print(f"[VectorStore] Pinecone delete error: {e2}")
            return False
