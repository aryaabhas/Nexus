"""
Firebase ID token verification middleware for FastAPI.
Usage as a dependency: current_user = Depends(get_current_user)
"""

import json
import os

import firebase_admin
from fastapi import HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from firebase_admin import auth as firebase_auth
from firebase_admin import credentials

# ── Initialize Firebase Admin SDK (once at module load) ──────────────────────
_firebase_initialized = False

def _init_firebase():
    global _firebase_initialized
    if _firebase_initialized or firebase_admin._apps:
        _firebase_initialized = True
        return

    # 1. Raw JSON string in environment variable (Ideal for Render / production)
    sa_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")
    if sa_json:
        try:
            cert_dict = json.loads(sa_json)
            cred = credentials.Certificate(cert_dict)
            firebase_admin.initialize_app(cred)
            _firebase_initialized = True
            return
        except Exception as e:
            print(f"[FirebaseAuth] Failed parsing FIREBASE_SERVICE_ACCOUNT_JSON: {e}")

    # 2. Local service account file path
    sa_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", "./serviceAccountKey.json")
    if os.path.exists(sa_path):
        cred = credentials.Certificate(sa_path)
        firebase_admin.initialize_app(cred)
        _firebase_initialized = True
        return

    # 3. Fallback: initialize with project ID options directly
    project_id = os.getenv("FIREBASE_PROJECT_ID", "vetra-2c756")
    try:
        cred = credentials.ApplicationDefault()
        firebase_admin.initialize_app(cred, {"projectId": project_id})
    except Exception:
        firebase_admin.initialize_app(options={"projectId": project_id})

    _firebase_initialized = True


_security = HTTPBearer()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Security(_security),
) -> dict:
    """
    FastAPI dependency that verifies a Firebase ID token from the
    'Authorization: Bearer <token>' header.
    Returns the decoded token dict on success.
    """
    _init_firebase()
    id_token = credentials.credentials
    try:
        decoded = firebase_auth.verify_id_token(id_token)
        return decoded
    except firebase_auth.ExpiredIdTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired. Please sign in again.",
        )
    except firebase_auth.InvalidIdTokenError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {e}",
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Authentication failed: {e}",
        )
