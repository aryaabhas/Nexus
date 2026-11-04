import datetime
import os
import boto3
from botocore.config import Config
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

R2_ACCOUNT_ID = os.getenv("R2_ACCOUNT_ID")
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY")
R2_BUCKET_NAME = os.getenv("R2_BUCKET_NAME", "nexus-mail-docs")

ENDPOINT_URL = f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

# Initialize S3-compatible client for Cloudflare R2
s3_client = boto3.client(
    service_name="s3",
    endpoint_url=ENDPOINT_URL,
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    config=Config(signature_version="s3v4"),
    region_name="auto"
)


def upload_file_bytes(
    uid: str,
    filename: str,
    file_bytes: bytes,
    content_type: str = "application/octet-stream",
    subfolder: str = "attachments"
) -> str:
    """
    Uploads file bytes directly to Cloudflare R2 under the isolated user path:
    users/{uid}/{subfolder}/{filename}
    Returns the storage key.
    """
    # Clean up filename to prevent path traversal
    safe_filename = os.path.basename(filename)
    key = f"users/{uid}/{subfolder}/{safe_filename}"
    s3_client.put_object(
        Bucket=R2_BUCKET_NAME,
        Key=key,
        Body=file_bytes,
        ContentType=content_type
    )
    return key


def get_presigned_download_url(key: str, expires_in: int = 3600) -> str:
    """
    Generates a secure temporary presigned download URL (valid for 1 hour by default).
    """
    return s3_client.generate_presigned_url(
        "get_object",
        Params={"Bucket": R2_BUCKET_NAME, "Key": key},
        ExpiresIn=expires_in
    )


def download_file_bytes(key: str) -> bytes:
    """
    Downloads file bytes directly from Cloudflare R2.
    """
    response = s3_client.get_object(Bucket=R2_BUCKET_NAME, Key=key)
    return response["Body"].read()


def delete_file(key: str):
    """
    Deletes an object from Cloudflare R2.
    """
    try:
        s3_client.delete_object(Bucket=R2_BUCKET_NAME, Key=key)
    except Exception as e:
        print(f"[R2Service] Error deleting file {key}: {e}")


def record_document_metadata(
    uid: str,
    key: str,
    filename: str,
    direction: str,  # "incoming" or "outgoing"
    associated_email: str,
    subject: str = "",
    size_bytes: int = 0,
    content_type: str = "application/octet-stream",
    message_id: str = ""
) -> None:
    """
    Record or update document metadata ledger in MongoDB for fast multi-tenant querying.
    """
    try:
        from db import r2_docs_collection
        now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
        r2_docs_collection.update_one(
            {"uid": uid, "key": key},
            {
                "$set": {
                    "uid": uid,
                    "key": key,
                    "filename": filename,
                    "direction": direction.lower(),
                    "associated_email": (associated_email or "").strip().lower(),
                    "subject": subject or "No Subject",
                    "size_bytes": size_bytes,
                    "content_type": content_type,
                    "message_id": message_id,
                    "updated_at": now_iso
                },
                "$setOnInsert": {
                    "created_at": now_iso
                }
            },
            upsert=True
        )
    except Exception as e:
        print(f"[R2Service] Error recording document metadata in Mongo: {e}")


def list_user_documents(
    uid: str,
    direction: str | None = None,
    email_filter: str | None = None
) -> list[dict]:
    """
    List all documents in Cloudflare R2 under users/{uid}/, enriched with
    direction (incoming/outgoing), associated email, subject, size, and fresh download URLs.
    """
    documents = []
    mongo_records = {}

    # 1. Fetch metadata ledger from MongoDB if available
    try:
        from db import r2_docs_collection
        query = {"uid": uid}
        cursor = r2_docs_collection.find(query, {"_id": 0})
        for item in cursor:
            mongo_records[item["key"]] = item
    except Exception as e:
        print(f"[R2Service] Notice: could not load Mongo doc records: {e}")

    # 2. Query R2 bucket directly to ensure consistency with actual storage
    prefix = f"users/{uid}/"
    r2_keys_seen = set()

    try:
        paginator = s3_client.get_paginator("list_objects_v2")
        page_iterator = paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix=prefix)

        for page in page_iterator:
            for obj in page.get("Contents", []):
                key = obj.get("Key", "")
                if not key or key.endswith("/"):
                    continue

                r2_keys_seen.add(key)
                size_bytes = obj.get("Size", 0)
                last_modified = obj.get("LastModified")
                date_str = last_modified.strftime("%d %b %Y, %H:%M") if last_modified else ""

                # Check Mongo record
                meta = mongo_records.get(key, {})

                # Determine direction ("incoming" vs "outgoing")
                doc_direction = meta.get("direction")
                if not doc_direction:
                    if "/incoming" in key:
                        doc_direction = "incoming"
                    elif "/outgoing" in key:
                        doc_direction = "outgoing"
                    else:
                        doc_direction = "incoming"

                # Determine clean filename
                raw_filename = meta.get("filename")
                if not raw_filename:
                    raw_filename = key.split("/")[-1]
                    # Strip any message_id prefix like msg123_filename.pdf
                    if "_" in raw_filename and len(raw_filename.split("_")[0]) >= 10:
                        raw_filename = "_".join(raw_filename.split("_")[1:])

                associated_email = meta.get("associated_email", "")
                subject = meta.get("subject", "Email Attachment")

                # Generate fresh presigned download URL
                try:
                    download_url = get_presigned_download_url(key, expires_in=7200)
                except Exception:
                    download_url = ""

                documents.append({
                    "key": key,
                    "filename": raw_filename,
                    "direction": doc_direction,
                    "associated_email": associated_email,
                    "subject": subject,
                    "size_bytes": size_bytes or meta.get("size_bytes", 0),
                    "date": date_str or meta.get("created_at", ""),
                    "download_url": download_url
                })
    except Exception as e:
        print(f"[R2Service] Error listing objects from R2: {e}")
        # If R2 listing fails, fallback to Mongo records with presigned URLs
        for key, meta in mongo_records.items():
            try:
                d_url = get_presigned_download_url(key, expires_in=7200)
            except Exception:
                d_url = ""
            documents.append({
                "key": key,
                "filename": meta.get("filename", key.split("/")[-1]),
                "direction": meta.get("direction", "incoming"),
                "associated_email": meta.get("associated_email", ""),
                "subject": meta.get("subject", ""),
                "size_bytes": meta.get("size_bytes", 0),
                "date": meta.get("created_at", ""),
                "download_url": d_url
            })

    # 3. Apply Filters
    filtered = []
    for doc in documents:
        if direction and direction.lower() != "all":
            if doc["direction"].lower() != direction.lower():
                continue

        if email_filter and email_filter.strip():
            ef = email_filter.strip().lower()
            if ef not in doc["associated_email"].lower() and ef not in doc["subject"].lower():
                continue

        filtered.append(doc)

    return filtered


def delete_user_document(uid: str, key: str) -> bool:
    """
    Safely delete a user's document from both Cloudflare R2 and MongoDB ledger.
    Ensures user can only delete within their own path users/{uid}/.
    """
    if not key.startswith(f"users/{uid}/"):
        raise PermissionError("Access denied: You cannot delete files outside your user workspace.")

    delete_file(key)
    try:
        from db import r2_docs_collection
        r2_docs_collection.delete_one({"uid": uid, "key": key})
    except Exception as e:
        print(f"[R2Service] Error deleting doc from Mongo: {e}")
    return True
