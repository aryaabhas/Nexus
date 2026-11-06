"""
Pipeline & Incident Intelligence Service.
Handles natural language client updates, stateful delta merging (preserving stages/values),
deterministic pipeline aggregations, historical discussion tracking, and hybrid context reporting.
"""

from datetime import datetime, timezone
import json
import re
from bson import ObjectId
from db import pipeline_collection, incidents_collection, profiles_collection, client_directory_collection
from services.openai_service import get_llm_client_and_model
from services import vector_store


DELTA_EXTRACTION_SYSTEM_PROMPT = """
You are an Executive CRM State Machine Engine.
Your job is to parse raw natural language updates from the user about clients/deals and merge them into the client's living state.

CALENDAR REFERENCE:
Today's date is: {current_calendar_str} (Year: {current_year}, Month: {current_month:02d}, Day: {current_day:02d}).

EXISTING KNOWN CLIENTS IN USER'S PIPELINE:
{existing_clients_json}

CRITICAL RULES:
1. CLIENT & COMPANY IDENTIFICATION:
   - Identify the company and person the update refers to (e.g., 'Figma', 'Acme Corp', 'John', 'Sarah from Vertex').
   - If this matches an existing client/company in the pipeline, map to their exact company_name and client_name.
   - If it is a new client/company, extract the new company_name and client_name.

2. STATEFUL DELTA PRESERVATION:
   - If the user's message does NOT mention a new deal stage, KEEP the existing deal_stage from the existing client record.
   - If the user's message does NOT mention a new deal price/value, KEEP the existing deal_value.
   - If this is a brand new client and no stage is mentioned, default deal_stage to "DISCOVERY".

3. DATE COMPUTATION & VACATIONS:
   - When a user mentions a date like "10 nov", "10th Nov", "Nov 10", "10th of November", "next Tuesday", etc., compute the EXACT ISO date (YYYY-MM-DD) using the calendar reference above ({current_year}-11-10).
   - If the message mentions vacation, leave, trip, holiday, or out-of-office:
     - status: "ON_VACATION"
     - details: description (e.g. "On vacation until Nov 10")
     - resume_date: exact ISO date string (YYYY-MM-DD). NEVER return null if a day or month was stated.
   - If they are back or available: status: "AVAILABLE".

4. DEAL STAGE & VALUE:
   - Stages: "LEAD", "DISCOVERY", "PROPOSAL", "NEGOTIATION", "FINAL_CLOSURE", "CLOSED_WON", "CLOSED_LOST".
   - Value: clean integer/float (e.g., "$50k" -> 50000, "85,000" -> 85000, null if not mentioned and no previous).

5. BLOCKERS & CONCERNS:
   - If the message mentions security concerns (SOC2, compliance), legal delays, budget cuts, or CISO review, capture under blockers array.

6. NEXT ACTION:
   - Extract immediate recommended next step and target follow-up date (in YYYY-MM-DD).

You must respond ONLY with a valid JSON object matching this schema:
{
  "company_name": "string",
  "client_name": "string",
  "client_email": "string or null",
  "deal_stage": "LEAD" | "DISCOVERY" | "PROPOSAL" | "NEGOTIATION" | "FINAL_CLOSURE" | "CLOSED_WON" | "CLOSED_LOST",
  "deal_value": number or null,
  "availability": {
    "status": "AVAILABLE" | "ON_VACATION" | "BUSY",
    "details": "string or null",
    "resume_date": "YYYY-MM-DD or null"
  },
  "blockers": [
    {"type": "SECURITY" | "LEGAL" | "BUDGET" | "OTHER", "description": "string"}
  ],
  "next_action": {
    "task": "string",
    "due_date": "YYYY-MM-DD or null"
  },
  "incident_summary": "1 concise sentence describing the update and discussion"
}
Do not include markdown code block wrappers (like ```json). Return raw JSON only.
"""


def _clean_json_str(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```json"):
        cleaned = cleaned[7:]
    elif cleaned.startswith("```"):
        cleaned = cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    return cleaned.strip()


def _parse_relative_or_text_date(text: str, base_date: datetime) -> str | None:
    """
    Regex fallback parser to guarantee extracting dates like '10 nov', '10th nov', 'nov 10', 'november 10'.
    """
    if not text:
        return None
    text_lower = text.lower()
    months = {
        'jan': 1, 'january': 1, 'feb': 2, 'february': 2, 'mar': 3, 'march': 3,
        'apr': 4, 'april': 4, 'may': 5, 'jun': 6, 'june': 6, 'jul': 7, 'july': 7,
        'aug': 8, 'august': 8, 'sep': 9, 'september': 9, 'oct': 10, 'october': 10,
        'nov': 11, 'november': 11, 'dec': 12, 'december': 12
    }
    
    # 1. Pattern: 10 nov, 10th nov, 10th of november
    m = re.search(r'(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)', text_lower)
    if m:
        day = int(m.group(1))
        mon = m.group(2)
        if mon in months and 1 <= day <= 31:
            month = months[mon]
            year = base_date.year
            if month < base_date.month or (month == base_date.month and day < base_date.day - 7):
                year += 1
            return f"{year}-{month:02d}-{day:02d}"

    # 2. Pattern: nov 10, november 10th
    m2 = re.search(r'([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?', text_lower)
    if m2:
        mon = m2.group(1)
        day = int(m2.group(2))
        if mon in months and 1 <= day <= 31:
            month = months[mon]
            year = base_date.year
            if month < base_date.month or (month == base_date.month and day < base_date.day - 7):
                year += 1
            return f"{year}-{month:02d}-{day:02d}"

    # 3. Pattern: YYYY-MM-DD
    m3 = re.search(r'\b(20\d\d)[-/.](\d{1,2})[-/.](\d{1,2})\b', text)
    if m3:
        return f"{m3.group(1)}-{int(m3.group(2)):02d}-{int(m3.group(3)):02d}"

    return None


async def preview_pipeline_incident(uid: str, text: str) -> dict:
    """
    Parses a raw natural language update, checks for existing accounts in the pipeline,
    cross-references the Client Directory, and returns a verified preview card
    for human-in-the-loop confirmation before committing to the database.
    """
    if not text or not text.strip():
        raise ValueError("Incident text cannot be empty.")

    now = datetime.now(timezone.utc)
    current_calendar_str = now.strftime('%A, %B %d, %Y')

    # 1. Fetch current pipeline for context (to resolve matches and preserve existing deal stages)
    existing_records = list(pipeline_collection.find(
        {"uid": uid},
        {"_id": 0, "client_name": 1, "company_name": 1, "deal_stage": 1, "deal_value": 1, "availability": 1, "client_email": 1}
    ).limit(35))

    existing_context_str = json.dumps(existing_records, indent=2) if existing_records else "None (Pipeline is currently empty)."

    # 2. Query LLM with delta preservation & date anchor prompt
    client, model_name = get_llm_client_and_model()
    system_prompt = (
        DELTA_EXTRACTION_SYSTEM_PROMPT
        .replace("{current_calendar_str}", current_calendar_str)
        .replace("{current_year}", str(now.year))
        .replace("{current_month:02d}", f"{now.month:02d}")
        .replace("{current_day:02d}", f"{now.day:02d}")
        .replace("{existing_clients_json}", existing_context_str)
    )

    response = await client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Update to process:\n\"{text.strip()}\""}
        ],
        temperature=0.2,
    )

    raw_output = response.choices[0].message.content
    cleaned_json = _clean_json_str(raw_output)

    try:
        extracted = json.loads(cleaned_json)
    except Exception as e:
        print(f"[PipelineService] JSON decode failed: {e}. Raw: {raw_output}")
        extracted = {
            "company_name": "General Client",
            "client_name": "Client",
            "client_email": None,
            "deal_stage": "DISCOVERY",
            "deal_value": None,
            "availability": {"status": "AVAILABLE", "details": text[:80], "resume_date": None},
            "blockers": [],
            "next_action": {"task": "Review latest update", "due_date": None},
            "incident_summary": text[:120]
        }

    company_name = extracted.get("company_name", "").strip() or "General Client"
    client_name = extracted.get("client_name", "").strip() or company_name
    client_email = extracted.get("client_email")
    deal_stage = extracted.get("deal_stage", "DISCOVERY").upper()
    deal_value = extracted.get("deal_value")
    availability = extracted.get("availability", {}) or {}
    blockers = extracted.get("blockers", []) or []
    next_action = extracted.get("next_action", {}) or {}
    summary = extracted.get("incident_summary", text[:100])

    # Regex date fallback
    raw_date = availability.get("resume_date")
    parsed_date = _parse_relative_or_text_date(text, now)
    if parsed_date:
        availability["resume_date"] = parsed_date
        availability["status"] = "ON_VACATION"
        if not availability.get("details"):
            availability["details"] = f"On vacation until {parsed_date}"
    elif raw_date:
        availability["resume_date"] = raw_date
        availability["status"] = "ON_VACATION"

    # Search existing pipeline account
    existing_doc = pipeline_collection.find_one({
        "uid": uid,
        "$or": [
            {"company_name": {"$regex": f"^{re.escape(company_name)}$", "$options": "i"}},
            {"client_name": {"$regex": f"^{re.escape(client_name)}$", "$options": "i"}}
        ]
    })

    matched_existing = existing_doc is not None
    existing_account = None
    if existing_doc:
        existing_account = {
            "id": str(existing_doc["_id"]),
            "company_name": existing_doc.get("company_name"),
            "client_name": existing_doc.get("client_name"),
            "deal_stage": existing_doc.get("deal_stage"),
            "deal_value": existing_doc.get("deal_value"),
            "availability": existing_doc.get("availability", {}),
            "associated_contacts": existing_doc.get("associated_contacts", [])
        }
        # Delta preservation for preview
        if not deal_stage or deal_stage == "DISCOVERY":
            deal_stage = existing_doc.get("deal_stage", "DISCOVERY")
        if deal_value is None:
            deal_value = existing_doc.get("deal_value")
        if not client_email:
            client_email = existing_doc.get("client_email")

    # Search Client Directory for associated contacts
    associated_contacts = []
    try:
        dir_matches = list(client_directory_collection.find(
            {"uid": uid, "$or": [
                {"company_name": {"$regex": f"^{re.escape(company_name)}$", "$options": "i"}},
                {"company": {"$regex": f"^{re.escape(company_name)}$", "$options": "i"}}
            ]}
        ).limit(10))
        for p in dir_matches:
            associated_contacts.append({
                "name": p.get("name") or client_name,
                "email": p.get("email") or "",
                "role": p.get("role") or p.get("designation") or "Client Contact",
                "phone": p.get("phone") or p.get("phone_number") or ""
            })
            if not client_email and p.get("email"):
                client_email = p.get("email")
    except Exception as de:
        print(f"[PipelineService] Directory query note: {de}")

    # Fallback to profiles_collection
    if not associated_contacts:
        try:
            matched_profiles = list(profiles_collection.find(
                {"uid": uid, "$or": [
                    {"company_name": {"$regex": f"^{re.escape(company_name)}$", "$options": "i"}},
                    {"company": {"$regex": f"^{re.escape(company_name)}$", "$options": "i"}}
                ]}
            ).limit(10))
            for p in matched_profiles:
                associated_contacts.append({
                    "name": p.get("name") or client_name,
                    "email": p.get("email") or "",
                    "role": p.get("designation") or p.get("role") or "Associated Contact",
                    "phone": p.get("phone_number") or ""
                })
        except Exception:
            pass

    # Ensure current client contact is listed
    if not any(c.get("name") == client_name for c in associated_contacts) and client_name:
        associated_contacts.append({
            "name": client_name,
            "email": client_email or "",
            "role": "Primary Contact",
            "phone": ""
        })

    return {
        "company_name": company_name,
        "client_name": client_name,
        "client_email": client_email or "",
        "deal_stage": deal_stage,
        "deal_value": deal_value,
        "availability": availability,
        "blockers": blockers,
        "next_action": next_action,
        "summary": summary,
        "raw_text": text,
        "matched_existing": matched_existing,
        "existing_account": existing_account,
        "associated_contacts": associated_contacts
    }


async def confirm_and_commit_incident(uid: str, data: dict) -> dict:
    """
    Commits a verified client update into MongoDB pipeline, writes audit incident,
    synchronizes/highlights the contact in the Client Directory, and embeds into Pinecone.
    """
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    company_name = data.get("company_name", "").strip() or "General Client"
    client_name = data.get("client_name", "").strip() or company_name
    client_email = data.get("client_email") or ""
    client_phone = data.get("client_phone") or ""
    deal_stage = (data.get("deal_stage") or "DISCOVERY").upper()
    deal_value = data.get("deal_value")
    if deal_value is not None:
        try:
            deal_value = float(deal_value)
        except Exception:
            pass

    availability = data.get("availability") or {"status": "AVAILABLE"}
    blockers = data.get("blockers") or []
    next_action = data.get("next_action") or {}
    summary = data.get("incident_summary") or data.get("summary") or "Client update processed."
    raw_text = data.get("raw_text") or summary
    sync_to_directory = data.get("sync_to_directory", True)
    incoming_contacts = data.get("associated_contacts") or []

    # 1. Match existing pipeline account
    existing_doc = pipeline_collection.find_one({
        "uid": uid,
        "$or": [
            {"company_name": {"$regex": f"^{re.escape(company_name)}$", "$options": "i"}},
            {"client_name": {"$regex": f"^{re.escape(client_name)}$", "$options": "i"}}
        ]
    })

    # Prepare merged contacts
    existing_contacts = existing_doc.get("associated_contacts", []) if existing_doc else []
    contacts_map = {c.get("email") or c.get("name"): c for c in existing_contacts}
    for ic in incoming_contacts:
        key = ic.get("email") or ic.get("name")
        if key:
            contacts_map[key] = ic
    final_contacts = list(contacts_map.values()) if contacts_map else incoming_contacts

    if existing_doc:
        final_stage = deal_stage or existing_doc.get("deal_stage", "DISCOVERY")
        final_val = deal_value if deal_value is not None else existing_doc.get("deal_value")
        final_em = client_email or existing_doc.get("client_email")

        pipeline_collection.update_one(
            {"_id": existing_doc["_id"]},
            {"$set": {
                "company_name": company_name,
                "client_name": client_name,
                "deal_stage": final_stage,
                "deal_value": final_val,
                "client_email": final_em,
                "associated_contacts": final_contacts,
                "availability": availability,
                "blockers": blockers if blockers else existing_doc.get("blockers", []),
                "next_action": next_action if next_action else existing_doc.get("next_action", {}),
                "last_incident_text": raw_text,
                "last_incident_summary": summary,
                "last_updated_at": now_iso
            }}
        )
        client_id_str = str(existing_doc["_id"])
    else:
        new_doc = {
            "uid": uid,
            "company_name": company_name,
            "client_name": client_name,
            "client_email": client_email,
            "associated_contacts": final_contacts,
            "deal_stage": deal_stage,
            "deal_value": deal_value or 0,
            "availability": availability,
            "blockers": blockers,
            "next_action": next_action,
            "last_incident_text": raw_text,
            "last_incident_summary": summary,
            "created_at": now_iso,
            "last_updated_at": now_iso
        }
        res = pipeline_collection.insert_one(new_doc)
        client_id_str = str(res.inserted_id)

    # 2. Insert audit incident
    incident_record = {
        "uid": uid,
        "client_id": client_id_str,
        "company_name": company_name,
        "client_name": client_name,
        "client_email": client_email,
        "raw_text": raw_text,
        "summary": summary,
        "extracted_state": data,
        "timestamp": now_iso
    }
    incidents_collection.insert_one(incident_record)

    # 3. Two-Way Client Directory Synchronization
    synced_directory_profile = None
    if sync_to_directory:
        try:
            profile_payload = {
                "uid": uid,
                "name": client_name,
                "email": client_email.lower().strip() if client_email else "",
                "phone": client_phone,
                "company": company_name,
                "company_name": company_name,
                "role": "Client Contact",
                "pipeline_stage": deal_stage,
                "pipeline_value": deal_value,
                "availability": availability,
                "status": deal_stage or "Lead",
                "last_interaction": raw_text,
                "updated_at": now_iso
            }
            # Search query for upserting
            query_cond = {"uid": uid}
            if client_email:
                query_cond["$or"] = [
                    {"email": client_email.lower().strip()},
                    {"name": client_name, "company": company_name}
                ]
            else:
                query_cond["name"] = client_name
                query_cond["company"] = company_name

            client_directory_collection.update_one(
                query_cond,
                {"$set": profile_payload, "$setOnInsert": {"created_at": now_iso}},
                upsert=True
            )
            synced_directory_profile = profile_payload
        except Exception as pe:
            print(f"[PipelineService] Directory sync error: {pe}")

    # 4. Pinecone Vector Embedding
    try:
        vector_store.add_document({
            "id": f"incident_{client_id_str}_{int(now.timestamp())}",
            "text": f"Client: {company_name} ({client_name}). Discussion update: {raw_text}. Deal Stage: {deal_stage}. Availability: {availability.get('status', 'AVAILABLE')} ({availability.get('details', '')}). Next step: {next_action.get('task', '')}.",
            "subject": f"Pipeline Discussion: {company_name}",
            "summary": summary,
            "uid": uid,
            "from": client_name,
            "entity_type": "client_incident",
            "company": company_name,
            "deal_stage": deal_stage,
            "availability": availability.get("status", "AVAILABLE")
        })
    except Exception as ve:
        print(f"[PipelineService] Pinecone indexing notice: {ve}")

    return {
        "client_id": client_id_str,
        "company_name": company_name,
        "client_name": client_name,
        "client_email": client_email,
        "associated_contacts": final_contacts,
        "deal_stage": deal_stage,
        "deal_value": deal_value,
        "availability": availability,
        "blockers": blockers,
        "next_action": next_action,
        "summary": summary,
        "synced_directory_profile": synced_directory_profile
    }


async def extract_and_merge_incident(uid: str, text: str) -> dict:
    """
    Backward-compatible wrapper: extracts preview and automatically commits.
    """
    preview = await preview_pipeline_incident(uid=uid, text=text)
    return await confirm_and_commit_incident(uid=uid, data=preview)


def get_pipeline_board(uid: str) -> dict:
    """
    Retrieves all tracked clients for user grouped by stage with aggregated metrics.
    """
    clients = list(pipeline_collection.find({"uid": uid}).sort("last_updated_at", -1))

    valid_stages = ["DISCOVERY", "PROPOSAL", "NEGOTIATION", "FINAL_CLOSURE", "CLOSED_WON", "CLOSED_LOST"]
    columns = {stage: [] for stage in valid_stages}
    
    total_open_deals = 0
    total_pipeline_value = 0

    for doc in clients:
        doc["id"] = str(doc.pop("_id"))
        stage = doc.get("deal_stage", "DISCOVERY")
        if stage not in columns:
            stage = "DISCOVERY"
        
        val = doc.get("deal_value") or 0
        if stage not in ["CLOSED_LOST"]:
            total_open_deals += 1
            total_pipeline_value += val

        columns[stage].append(doc)

    return {
        "metrics": {
            "total_open_deals": total_open_deals,
            "total_pipeline_value": total_pipeline_value,
            "stage_counts": {s: len(columns[s]) for s in valid_stages},
            "stage_values": {s: sum((c.get("deal_value") or 0) for c in columns[s]) for s in valid_stages}
        },
        "columns": columns
    }


def get_client_history(uid: str, client_id_or_company: str) -> dict:
    """
    Fetch the complete chronological history of all updates and discussions for a specific client.
    """
    client = None
    if ObjectId.is_valid(client_id_or_company):
        client = pipeline_collection.find_one({"_id": ObjectId(client_id_or_company), "uid": uid})
    
    if not client:
        client = pipeline_collection.find_one({
            "uid": uid,
            "$or": [
                {"company_name": {"$regex": f"^{re.escape(client_id_or_company)}$", "$options": "i"}},
                {"client_name": {"$regex": f"^{re.escape(client_id_or_company)}$", "$options": "i"}}
            ]
        })

    if not client:
        client = pipeline_collection.find_one({
            "uid": uid,
            "$or": [
                {"company_name": {"$regex": re.escape(client_id_or_company), "$options": "i"}},
                {"client_name": {"$regex": re.escape(client_id_or_company), "$options": "i"}}
            ]
        })

    if not client:
        return {"client": None, "incidents": []}

    client_id_str = str(client["_id"])
    company_name = client.get("company_name", "")
    client_name = client.get("client_name", "")

    incidents = list(incidents_collection.find({
        "uid": uid,
        "$or": [
            {"client_id": client_id_str},
            {"company_name": {"$regex": f"^{re.escape(company_name)}$", "$options": "i"}},
            {"client_name": {"$regex": f"^{re.escape(client_name)}$", "$options": "i"}}
        ]
    }).sort("timestamp", 1))

    for inc in incidents:
        inc["id"] = str(inc.pop("_id"))

    client_copy = dict(client)
    client_copy["id"] = client_id_str
    client_copy.pop("_id", None)

    return {
        "client": client_copy,
        "incidents": incidents
    }


async def generate_client_closure_dossier(uid: str, client_id_or_company: str) -> dict:
    """
    Generate an executive, comprehensive deal closure / client dossier report
    synthesizing all discussions, timeline of events, agreements, and final terms.
    """
    history_data = get_client_history(uid, client_id_or_company)
    client_info = history_data.get("client")
    incidents = history_data.get("incidents", [])

    if not client_info:
        raise ValueError(f"Client '{client_id_or_company}' not found in pipeline.")

    client, model_name = get_llm_client_and_model()

    system_prompt = (
        "You are an Executive Deal Desk Analyst and Strategic Account Director for Nexus. "
        "Your task is to generate a comprehensive, board-ready Client Deal Dossier & Post-Closure Sales Report "
        "for the specified client. Synthesize the complete chronological history of all discussions, meetings, "
        "commitments made, objections/vacations navigated, and final deal terms.\n\n"
        "REPORT STRUCTURE TO PRODUCE IN CLEAN GITHUB-STYLE MARKDOWN:\n"
        "1. # 📄 Executive Client Dossier: [Company Name]\n"
        "2. **Deal Snapshot:** Stage, Value, Primary Client Contact, Associated Team, Status.\n"
        "3. **Chronological Discussion Timeline:** Detail every logged update with its date, what was discussed, and decisions reached.\n"
        "4. **Key Commitments & Milestones:** What was promised to them, what they promised to us.\n"
        "5. **Post-Closure / Relationship Action Plan:** Recommended onboarding, relationship maintenance, or upsell steps.\n\n"
        "Be factual, structured, and use dates and currency numbers accurately. No conversational fluff."
    )

    user_prompt = (
        f"CLIENT SUMMARY:\n{json.dumps(client_info, indent=2)}\n\n"
        f"COMPLETE CHRONOLOGICAL DISCUSSION HISTORY ({len(incidents)} logged updates):\n"
        f"{json.dumps(incidents, indent=2)}"
    )

    response = await client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        temperature=0.3,
    )

    markdown_report = response.choices[0].message.content.strip()

    return {
        "client": client_info,
        "total_discussions": len(incidents),
        "markdown_report": markdown_report
    }


async def query_pipeline_and_generate_report(uid: str, query: str) -> dict:
    """
    Executes analytical sales pipeline queries.
    Handles:
    1. 'history of updates on [Company]' or 'discussions with [Client]' -> pulls full chronological incident logs.
    2. 'total companies in pipeline with client details' -> breaks down every company with its associated contacts.
    3. 'how many deals on final closure' -> deterministic counting + status breakdown.
    """
    board_data = get_pipeline_board(uid)
    metrics = board_data["metrics"]
    columns = board_data["columns"]
    all_clients = []
    for col in columns.values():
        all_clients.extend(col)

    query_lower = query.lower()

    # Check if query is asking for history/discussions of a specific company
    matched_target = None
    for c in all_clients:
        comp = c.get("company_name", "").lower()
        cli = c.get("client_name", "").lower()
        if comp and (comp in query_lower or query_lower in comp):
            matched_target = c
            break
        if cli and (cli in query_lower or query_lower in cli):
            matched_target = c
            break

    client_history_context = []
    if matched_target or "history" in query_lower or "update" in query_lower or "discussion" in query_lower:
        target_name = matched_target.get("company_name") if matched_target else query.strip()
        hist = get_client_history(uid, target_name)
        if hist.get("incidents"):
            client_history_context = hist["incidents"]

    # Qualitative search in Pinecone vector store
    context_docs = []
    try:
        context_docs = vector_store.search(query, uid=uid, k=5)
    except Exception as e:
        print(f"[PipelineService] Vector query note: {e}")

    # Build comprehensive verified summary string for the LLM
    verified_data = {
        "total_companies_in_pipeline": len(all_clients),
        "total_open_sales_count": metrics["total_open_deals"],
        "total_pipeline_value_usd": metrics["total_pipeline_value"],
        "companies_list": [
            {
                "company_name": i.get("company_name"),
                "primary_client": i.get("client_name"),
                "client_email": i.get("client_email"),
                "associated_contacts": i.get("associated_contacts") or [{"name": i.get("client_name"), "email": i.get("client_email")}],
                "deal_stage": i.get("deal_stage"),
                "deal_value": i.get("deal_value"),
                "availability": i.get("availability"),
                "blockers": i.get("blockers"),
                "next_action": i.get("next_action"),
                "latest_update": i.get("last_incident_summary")
            }
            for i in all_clients
        ],
        "stages": {}
    }

    for stage, items in columns.items():
        if items:
            verified_data["stages"][stage] = {
                "count": len(items),
                "total_value": sum((i.get("deal_value") or 0) for i in items),
                "companies": [i.get("company_name") for i in items]
            }

    client, model_name = get_llm_client_and_model()

    system_prompt = (
        "You are the Chief Commercial Officer & Senior Sales Intelligence Analyst for Nexus.\n"
        "You are provided with VERIFIED pipeline data computed deterministically from the database, "
        "as well as chronological discussion/incident logs and vector memory.\n\n"
        "STRICT COMPLIANCE RULES:\n"
        "1. EXACT NUMBERS: Use the exact deal counts and monetary values provided in the verified data. Never invent numbers.\n"
        "2. SPECIFIC CLIENT/COMPANY INQUIRIES (e.g. 'history of updates on Figma'):\n"
        "   - You MUST list the complete chronological timeline of discussions with exact dates/timestamps.\n"
        "   - Highlight what was discussed, what commitments were made, vacation alerts, and current deal stage.\n"
        "3. 'TOTAL COMPANIES IN PIPELINE WITH CLIENT DETAILS':\n"
        "   - State the total count of companies.\n"
        "   - For EACH company, explicitly list: Company Name, Associated Client Contact(s) (name & email), Deal Stage, Deal Value ($), Active Availability/Vacation status, and Next Action.\n"
        "4. 'FINAL STAGE CLOSURE' INQUIRIES:\n"
        "   - State the exact count and list every client in FINAL_CLOSURE with their vacation dates and signature status.\n"
        "5. TONE & FORMAT: Professional, board-ready, concise Markdown with bullet points and bold highlights."
    )

    user_prompt = (
        f"USER QUESTION / REQUEST:\n\"{query}\"\n\n"
        f"VERIFIED PIPELINE DATA (Single Source of Truth):\n{json.dumps(verified_data, indent=2)}\n\n"
        f"CHRONOLOGICAL DISCUSSION LOGS FOR TARGET CLIENT (if applicable):\n{json.dumps(client_history_context, indent=2)}\n\n"
        f"RECENT RELEVANT VECTOR MEMORY CHUNKS:\n{json.dumps([d.get('summary') or d.get('text', '') for d in context_docs], indent=2)}"
    )

    response = await client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        temperature=0.2,
    )

    markdown_report = response.choices[0].message.content.strip()

    return {
        "metrics": metrics,
        "matched_client": matched_target.get("company_name") if matched_target else None,
        "markdown_report": markdown_report
    }


def get_client_directory_profiles(uid: str) -> list:
    """Returns all client profiles stored in MongoDB client_directory_collection."""
    try:
        profiles = list(client_directory_collection.find({"uid": uid}, {"_id": 0}).sort("updated_at", -1))
        return profiles
    except Exception as e:
        print(f"[PipelineService] Directory query error: {e}")
        return []


def delete_pipeline_client(uid: str, client_id: str) -> bool:
    """Permanently delete a client from the pipeline."""
    try:
        res = pipeline_collection.delete_one({"_id": ObjectId(client_id), "uid": uid})
        return res.deleted_count > 0
    except Exception:
        return False
