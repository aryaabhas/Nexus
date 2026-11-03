import os
from dotenv import load_dotenv
from pymongo import MongoClient

# Ensure environment variables are loaded
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017")
DB_NAME = os.getenv("MONGO_DB_NAME", "nexus_db")

client = MongoClient(MONGO_URI)
db = client[DB_NAME]

# Collections
tasks_collection = db["tasks"]
crm_collection = db["crm_interactions"]
logs_collection = db["activity_logs"]
profiles_collection = db["user_profiles"]
threads_collection = db["tracked_threads"]
graph_collection = db["graph_data"]
metadata_collection = db["email_metadata"]
calendar_collection = db["calendar_events"]

