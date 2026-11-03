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
        results = []
        for match in matches:
            match_id = getattr(match, "id", None) or getattr(match, "_id", None)
            score = float(getattr(match, "score", 0.0))
            
            # Retrieve metadata from MongoDB
            meta = metadata_collection.find_one({"message_id": match_id, "uid": uid}, {"_id": 0})
            if not meta:
                # Fallback if doc_id was used
                meta = metadata_collection.find_one({"doc_id": match_id, "uid": uid}, {"_id": 0})

            if meta:
                meta["score"] = score
                results.append(meta)
            else:
                title = getattr(match, "title", "")
                results.append({
                    "message_id": match_id,
                    "doc_id": match_id,
                    "subject": title,
                    "score": score
                })
        return results
    except Exception as e:
        print(f"[VectorStore] Search error in Pinecone: {e}")
        return []

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
