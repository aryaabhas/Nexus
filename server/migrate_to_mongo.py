import os
import json
from dotenv import load_dotenv
from pymongo import MongoClient

# Load .env
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

MONGO_URI = os.getenv("MONGO_URI")
DB_NAME = os.getenv("MONGO_DB_NAME", "nexus_db")
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")

def run_migration():
    if not MONGO_URI:
        print("Error: MONGO_URI not found in .env")
        return

    print(f"Connecting to MongoDB Atlas...")
    client = MongoClient(MONGO_URI)
    db = client[DB_NAME]
    
    # Test connection
    client.admin.command('ping')
    print(f"Successfully connected to MongoDB Atlas! Target database: '{DB_NAME}'\n")

    json_files = [f for f in os.listdir(DATA_DIR) if f.endswith(".json")]

    for filename in json_files:
        filepath = os.path.join(DATA_DIR, filename)
        col_name = filename.replace(".json", "")
        col = db[col_name]

        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)

            if not data:
                print(f"[-] {filename}: empty, skipped.")
                continue

            if isinstance(data, list):
                # Wipe old data in collection to avoid duplicates during initial import
                col.delete_many({})
                col.insert_many(data)
                print(f"[OK] {filename} -> collection '{col_name}': imported {len(data)} items.")

            elif isinstance(data, dict):
                col.delete_many({})
                # If dictionary is key-value records (e.g. user_profiles: {uid: profile}), store each entry as a document
                if col_name == "user_profiles":
                    records = []
                    for uid, profile in data.items():
                        records.append({"uid": uid, **profile})
                    if records:
                        col.insert_many(records)
                        print(f"[OK] {filename} -> collection '{col_name}': imported {len(records)} user profiles.")
                elif col_name == "graph_data":
                    # Store graph structure
                    col.insert_one({"_id": "global_graph", **data})
                    print(f"[OK] {filename} -> collection '{col_name}': imported graph object.")
                else:
                    col.insert_one({"_id": "root_data", **data})
                    print(f"[OK] {filename} -> collection '{col_name}': imported dictionary.")

        except Exception as e:
            print(f"[X] Error importing {filename}: {e}")

    # Check scratchpads/calendar files if any
    scratchpads_dir = os.path.join(DATA_DIR, "scratchpads")
    if os.path.exists(scratchpads_dir):
        cal_col = db["calendar_events"]
        for cal_file in os.listdir(scratchpads_dir):
            if cal_file.endswith(".json"):
                uid = cal_file.replace(".json", "")
                cal_path = os.path.join(scratchpads_dir, cal_file)
                try:
                    with open(cal_path, "r", encoding="utf-8") as f:
                        cal_data = json.load(f)
                    cal_col.delete_many({"uid": uid})
                    if isinstance(cal_data, list):
                        for event in cal_data:
                            event["uid"] = uid
                        if cal_data:
                            cal_col.insert_many(cal_data)
                    print(f"[✓] scratchpads/{cal_file} -> collection 'calendar_events': imported.")
                except Exception as e:
                    print(f"[X] Error importing {cal_file}: {e}")

    print("\nAll JSON data successfully migrated to MongoDB Atlas!")

if __name__ == "__main__":
    run_migration()
