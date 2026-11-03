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

def upload_file_bytes(uid: str, filename: str, file_bytes: bytes, content_type: str = "application/octet-stream", subfolder: str = "attachments") -> str:
    """
    Uploads file bytes directly to Cloudflare R2 under the isolated user path:
    users/{uid}/{subfolder}/{filename}
    Returns the storage key.
    """
    key = f"users/{uid}/{subfolder}/{filename}"
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

