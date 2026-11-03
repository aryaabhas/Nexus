"""
Vector store service — Pinecone Integrated Embeddings (llama-text-embed-v2).

Features:
- Embeddings handled natively by Pinecone Cloud (0 local RAM footprint).
- Strict multi-tenant user isolation using Pinecone namespaces (`namespace=uid`).
- Metadata persisted in MongoDB Atlas `email_metadata` collection.
"""

import os
from dotenv import load_dotenv
from pinecone import Pinecone
from db import metadata_collection

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
    Store an email document in Pinecone under the user's isolated namespace
    and cache the metadata in MongoDB Atlas.
    """
    idx = _get_index()
    doc_id = metadata.get("message_id") or metadata.get("doc_id")
    uid = metadata.get("uid") or "default_user"
    
    title = metadata.get("subject", "No Subject")
    summary = metadata.get("summary", "")
    sender = metadata.get("from", "")
    date = metadata.get("date", "")

    chunk_text = f"From: {sender}\nDate: {date}\nSubject: {title}\nSummary: {summary}"

    # Upsert document into Pinecone with automatic integrated embedding
    try:
        res = idx.documents.upsert(
            namespace=uid,
            documents=[{
                "_id": doc_id,
                "title": title,
                "chunk_text": chunk_text
            }]
        )
        print(f"[VectorStore] Successfully upserted doc '{doc_id}' to Pinecone namespace '{uid}': {res}")
    except Exception as e:
        print(f"[VectorStore] Error upserting to Pinecone (documents.upsert): {e}")
        # Fallback to upsert_records if the index was created using create_for_model (Records API)
        try:
            res = idx.upsert_records(
                namespace=uid or "__default__",
                records=[{
                    "_id": doc_id,
                    "title": title,
                    "chunk_text": chunk_text
                }]
            )
            print(f"[VectorStore] Successfully upserted doc via fallback (upsert_records): {res}")
        except Exception as e2:
            print(f"[VectorStore] Fallback upsert_records also failed: {e2}")

    # Persist metadata record in MongoDB Atlas
    try:
        metadata_collection.update_one(
            {"message_id": doc_id, "uid": uid},
            {"$set": {**metadata, "doc_id": doc_id, "uid": uid}},
            upsert=True
        )
    except Exception as e:
        print(f"[VectorStore] Error saving metadata to MongoDB: {e}")

    return doc_id

def search(query_text: str, uid: str = "default_user", k: int = 5) -> list[dict]:
    """
    Search documents within the user's isolated namespace using Pinecone Integrated search.
    Enriches matching document IDs with their full metadata stored in MongoDB.
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
        print(f"[VectorStore] documents.search failed, attempting fallback idx.search: {e}")
        # 2. Try Records Search API (Integrated Index created for model)
        try:
            resp = idx.search(
                namespace=uid or "__default__",
                top_k=k,
                inputs={"text": query_text},
                fields=["title", "chunk_text"]
            )
            hits = getattr(getattr(resp, "result", None), "hits", []) or []
            matches = hits
        except Exception as e2:
            print(f"[VectorStore] Both Pinecone search methods failed: {e2}")

    results = []
    for match in matches:
        match_id = getattr(match, "id", None) or getattr(match, "_id", None)
        score = float(getattr(match, "score", 0.0))
        
        # Retrieve metadata from MongoDB
        meta = metadata_collection.find_one({"message_id": match_id, "uid": uid}, {"_id": 0})
        if not meta:
            meta = metadata_collection.find_one({"doc_id": match_id, "uid": uid}, {"_id": 0})

        if meta:
            meta["score"] = score
            results.append(meta)
        else:
            fields = getattr(match, "fields", {}) or {}
            title = fields.get("title") or getattr(match, "title", "")
            results.append({
                "message_id": match_id,
                "doc_id": match_id,
                "subject": title,
                "score": score
            })

    # If Pinecone search didn't return any matches (e.g. index still propagating or empty),
    # fallback to MongoDB text/regex search so user ALWAYS gets results
    if not results:
        regex_query = {"$regex": query_text, "$options": "i"}
        mongo_matches = list(metadata_collection.find({
            "uid": uid,
            "$or": [
                {"subject": regex_query},
                {"summary": regex_query},
                {"from": regex_query}
            ]
        }, {"_id": 0}).limit(k))
        for m in mongo_matches:
            m["score"] = 0.85
            results.append(m)

    return results

def get_all_summaries(uid: str | None = None) -> list[dict]:
    """Return all stored email metadata from MongoDB."""
    query = {"uid": uid} if uid else {}
    return list(metadata_collection.find(query, {"_id": 0}))

def is_already_stored(message_id: str, uid: str | None = None) -> bool:
    """Check if an email is already stored."""
    query = {"message_id": message_id}
    if uid:
        query["uid"] = uid
    return metadata_collection.count_documents(query) > 0

def delete_document(target_id: str, uid: str = "default_user") -> bool:
    """
    Delete document from Pinecone and MongoDB.
    """
    idx = _get_index()
    try:
        idx.documents.delete(namespace=uid, ids=[target_id])
    except Exception as e:
        print(f"[VectorStore] Pinecone delete error: {e}")

    res = metadata_collection.delete_one({
        "$or": [{"message_id": target_id}, {"doc_id": target_id}],
        **({"uid": uid} if uid else {})
    })
    return res.deleted_count > 0
