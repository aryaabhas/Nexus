from fastapi import APIRouter, Depends
from middleware.firebase_auth import get_current_user
from pydantic import BaseModel
from db import profiles_collection

router = APIRouter(prefix="/api/profile", tags=["profile"])

class UserProfileSchema(BaseModel):
    name: str
    designation: str
    company_name: str
    phone_number: str

@router.get("")
async def get_profile(user: dict = Depends(get_current_user)):
    uid = user.get("uid", "")
    profile = profiles_collection.find_one({"uid": uid}, {"_id": 0})
    if not profile:
        return {
            "name": "",
            "designation": "",
            "company_name": "",
            "phone_number": ""
        }
    return {
        "name": profile.get("name", ""),
        "designation": profile.get("designation", ""),
        "company_name": profile.get("company_name", ""),
        "phone_number": profile.get("phone_number", "")
    }

@router.post("")
async def save_profile(body: UserProfileSchema, user: dict = Depends(get_current_user)):
    uid = user.get("uid", "")
    profile_data = {
        "name": body.name,
        "designation": body.designation,
        "company_name": body.company_name,
        "phone_number": body.phone_number
    }
    profiles_collection.update_one(
        {"uid": uid},
        {"$set": {"uid": uid, **profile_data}},
        upsert=True
    )
    return {"status": "success", "profile": profile_data}
