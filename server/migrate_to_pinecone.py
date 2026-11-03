import os
import json
from dotenv import load_dotenv
from pinecone import Pinecone

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

PINECONE_API_KEY = os.getenv("PINECONE_API_KEY")
INDEX_NAME = os.getenv("PINECONE_INDEX_NAME", "nexus-emails")

def migrate():
    metadata_path = os.path.join(os.path.dirname(__file__), "data", "email_metadata.json")
    if not os.path.exists(metadata_path):
        print("No email_metadata.json found to migrate.")
        return

    with open(metadata_path, "r", encoding="utf-8") as f:
        records = json.load(f)

    if not records:
        print("No records found in email_metadata.json.")
        return

    print(f"Connecting to Pinecone index '{INDEX_NAME}'...")
    pc = Pinecone(api_key=PINECONE_API_KEY)
    index = pc.Index(INDEX_NAME)

    # Group by uid namespace
    by_namespace = {}
    for r in records:
        uid = r.get("uid") or "default_user"
        if uid not in by_namespace:
            by_namespace[uid] = []
        
        doc_id = r.get("message_id") or r.get("doc_id")
        title = r.get("subject", "No Subject")
        summary = r.get("summary", "")
        sender = r.get("from", "")
        date = r.get("date", "")

        chunk_text = f"From: {sender}\nDate: {date}\nSubject: {title}\nSummary: {summary}"

        by_namespace[uid].append({
            "_id": doc_id,
            "title": title,
            "chunk_text": chunk_text
        })

    total_migrated = 0
    for uid, docs in by_namespace.items():
        print(f"Upserting {len(docs)} documents for user namespace '{uid}'...")
        resp = index.documents.upsert(namespace=uid, documents=docs)
        total_migrated += resp.upserted_count
        print(f"User '{uid}': upserted {resp.upserted_count} documents.")

    print(f"\nMigration complete! Total documents uploaded to Pinecone: {total_migrated}")

if __name__ == "__main__":
    migrate()

