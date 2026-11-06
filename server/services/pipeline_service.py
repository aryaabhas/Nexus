"""
Pipeline & Incident Intelligence Service.
Handles natural language client updates, stateful delta merging (preserving stages/values),
deterministic pipeline aggregations, and hybrid context reporting.
"""

from datetime import datetime, timezone
import json
import re
from bson import ObjectId
from db import pipeline_collection, incidents_collection
from services.openai_service import get_llm_client_and_model
from services import vector_store


DELTA_EXTRACTION_SYSTEM_PROMPT = """
You are an Executive CRM State Machine Engine.
Your job is to parse raw natural language updates from the user about clients/deals and merge them into the client's living state.

EXISTING KNOWN CLIENTS IN USER'S PIPELINE:
{existing_clients_json}

CRITICAL RULES:
1. CLIENT IDENTIFICATION:
   - Identify which client or company the update refers to (e.g., 'Acme Corp', 'John', 'Sarah from Vertex').
   - If this matches an existing client in the pipeline, map to their exact company_name and client_name.
   - If it is a new client, extract the new company_name and client_name.

2. STATEFUL DELTA PRESERVATION:
   - If the user's message does NOT mention a new deal stage, KEEP the existing deal_stage from the existing client record.
   - If the user's message does NOT mention a new deal price/value, KEEP the existing deal_value.
   - If this is a brand new client and no stage is mentioned, default deal_stage to "DISCOVERY".

3. AVAILABILITY & VACATIONS:
   - If the message mentions vacation, leave, trip, holiday, or out-of-office (e.g. 'on vacation', 'back on 10 Nov', 'away in Hawaii till 18th'):
     - status: "ON_VACATION"
     - details: brief text (e.g. "On vacation until Nov 10")
     - resume_date: ISO date (YYYY-MM-DD) if identifiable, otherwise null.
   - If they are back or available: status: "AVAILABLE".

4. DEAL STAGE & VALUE:
   - Stages: "LEAD", "DISCOVERY", "PROPOSAL", "NEGOTIATION", "FINAL_CLOSURE", "CLOSED_WON", "CLOSED_LOST".
   - Value: clean integer/float (e.g., "$50k" -> 50000, "85,000" -> 85000, null if not mentioned and no previous).

5. BLOCKERS & CONCERNS:
   - If the message mentions security concerns (SOC2, compliance), legal delays, budget cuts, or CISO review, capture under blockers array.

6. NEXT ACTION:
   - Extract immediate recommended next step and target follow-up date.

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
  "incident_summary": "1 concise sentence describing the update"
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


async def extract_and_merge_incident(uid: str, text: str) -> dict:
    """
    Parses a raw natural language client update, applies stateful delta updates,
    upserts into MongoDB 'client_pipeline', logs into 'client_incidents',
    and indexes into Pinecone vector store with rich metadata.
    """
    if not text or not text.strip():
        raise ValueError("Incident text cannot be empty.")

    # 1. Fetch current pipeline for context (to resolve matches and preserve existing deal stages)
    existing_records = list(pipeline_collection.find(
        {"uid": uid},
        {"_id": 0, "client_name": 1, "company_name": 1, "deal_stage": 1, "deal_value": 1, "availability": 1}
    ).limit(30))

    existing_context_str = json.dumps(existing_records, indent=2) if existing_records else "None (Pipeline is currently empty)."

    # 2. Query LLM with delta preservation prompt
    client, model_name = get_llm_client_and_model()
    system_prompt = DELTA_EXTRACTION_SYSTEM_PROMPT.replace("{existing_clients_json}", existing_context_str)

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
        # Fallback simple extraction
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

    company_name = extracted.get("company_name", "Unknown").strip()
    client_name = extracted.get("client_name", "").strip() or company_name
    deal_stage = extracted.get("deal_stage", "DISCOVERY").upper()
    deal_value = extracted.get("deal_value")
    availability = extracted.get("availability", {})
    blockers = extracted.get("blockers", [])
    next_action = extracted.get("next_action", {})
    summary = extracted.get("incident_summary", text[:100])

    now_iso = datetime.now(timezone.utc).isoformat()

    # 3. Match existing client record in MongoDB
    match_query = {
        "uid": uid,
        "$or": [
            {"company_name": {"$regex": f"^{re.escape(company_name)}$", "$options": "i"}},
            {"client_name": {"$regex": f"^{re.escape(client_name)}$", "$options": "i"}}
        ]
    }
    existing_doc = pipeline_collection.find_one(match_query)

    if existing_doc:
        # Preserve stage/value if LLM returned null or default and existing already had one
        final_stage = deal_stage or existing_doc.get("deal_stage", "DISCOVERY")
        final_value = deal_value if deal_value is not None else existing_doc.get("deal_value")
        
        # Merge blockers: if none in update, keep existing blockers if still active
        final_blockers = blockers if blockers else existing_doc.get("blockers", [])

        pipeline_collection.update_one(
            {"_id": existing_doc["_id"]},
            {"$set": {
                "deal_stage": final_stage,
                "deal_value": final_value,
                "availability": availability,
                "blockers": final_blockers,
                "next_action": next_action,
                "last_incident_text": text,
                "last_incident_summary": summary,
                "last_updated_at": now_iso
            }}
        )
        client_id_str = str(existing_doc["_id"])
    else:
        # Create new client record in pipeline
        new_doc = {
            "uid": uid,
            "company_name": company_name,
            "client_name": client_name,
            "client_email": extracted.get("client_email"),
            "deal_stage": deal_stage,
            "deal_value": deal_value or 0,
            "availability": availability,
            "blockers": blockers,
            "next_action": next_action,
            "last_incident_text": text,
            "last_incident_summary": summary,
            "created_at": now_iso,
            "last_updated_at": now_iso
        }
        res = pipeline_collection.insert_one(new_doc)
        client_id_str = str(res.inserted_id)

    # 4. Insert audit incident
    incident_record = {
        "uid": uid,
        "client_id": client_id_str,
        "company_name": company_name,
        "client_name": client_name,
        "raw_text": text,
        "summary": summary,
        "extracted_state": extracted,
        "timestamp": now_iso
    }
    incidents_collection.insert_one(incident_record)

    # 5. Index into Pinecone Vector Store for semantic recall
    try:
        vector_store.add_document({
            "id": f"incident_{client_id_str}_{int(datetime.now().timestamp())}",
            "text": f"Client: {company_name} ({client_name}). Incident update: {text}. Current stage: {deal_stage}. Availability: {availability.get('status', 'AVAILABLE')} ({availability.get('details', '')}).",
            "subject": f"Pipeline Update: {company_name}",
            "summary": summary,
            "uid": uid,
            "from": client_name,
            "entity_type": "client_incident",
            "deal_stage": deal_stage,
            "availability": availability.get("status", "AVAILABLE")
        })
    except Exception as ve:
        print(f"[PipelineService] Pinecone indexing notice: {ve}")

    return {
        "company_name": company_name,
        "client_name": client_name,
        "deal_stage": deal_stage,
        "deal_value": deal_value,
        "availability": availability,
        "blockers": blockers,
        "next_action": next_action,
        "summary": summary
    }


def get_pipeline_board(uid: str) -> dict:
    """
    Retrieves all tracked clients for user grouped by stage with aggregated metrics.
    Deterministic aggregation via MongoDB.
    """
    clients = list(pipeline_collection.find({"uid": uid}).sort("last_updated_at", -1))

    # Standard stage columns
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


async def query_pipeline_and_generate_report(uid: str, query: str) -> dict:
    """
    Executes an analytical sales pipeline query (e.g. 'What are open sales and how many on final closure?').
    Combines deterministic MongoDB aggregation metrics + qualitative Pinecone incident vectors + LLM synthesis.
    """
    board_data = get_pipeline_board(uid)
    metrics = board_data["metrics"]
    columns = board_data["columns"]

    # Qualitative search in Pinecone vector store
    context_docs = []
    try:
        context_docs = vector_store.search(query, uid=uid, k=5)
    except Exception as e:
        print(f"[PipelineService] Vector query note: {e}")

    # Build concise verified summary string for the LLM
    verified_data = {
        "total_open_sales_count": metrics["total_open_deals"],
        "total_pipeline_value_usd": metrics["total_pipeline_value"],
        "stages": {}
    }

    for stage, items in columns.items():
        if items:
            verified_data["stages"][stage] = {
                "count": len(items),
                "total_value": sum((i.get("deal_value") or 0) for i in items),
                "clients": [
                    {
                        "company": i.get("company_name"),
                        "client": i.get("client_name"),
                        "value": i.get("deal_value"),
                        "availability": i.get("availability"),
                        "blockers": i.get("blockers"),
                        "next_action": i.get("next_action"),
                        "last_update": i.get("last_incident_summary")
                    }
                    for i in items
                ]
            }

    # Synthesize via LLM
    client, model_name = get_llm_client_and_model()

    system_prompt = (
        "You are the Chief Commercial Officer & Senior Sales Intelligence Analyst for Nexus. "
        "You are provided with VERIFIED pipeline data computed deterministically from the database, "
        "as well as recent incident notes from vector memory.\n\n"
        "STRICT COMPLIANCE RULES:\n"
        "1. EXACT NUMBERS: Use the exact deal counts and monetary values provided in the verified data. Never invent or hallucinate numbers.\n"
        "2. ACCURACY: If asked how many deals are in 'final closure', answer directly with the exact count and list those specific clients.\n"
        "3. CLIENT INTELLIGENCE: Explicitly mention client availability (e.g. 🏖️ On vacation until date), active blockers (e.g. ⚠️ SOC2 compliance, legal hold), and next recommended actions.\n"
        "4. TONE & FORMAT: Professional, board-ready, concise Markdown with bullet points and bold highlights. Avoid conversational filler."
    )

    user_prompt = (
        f"USER QUESTION / REQUEST:\n\"{query}\"\n\n"
        f"VERIFIED PIPELINE DATA (Single Source of Truth):\n{json.dumps(verified_data, indent=2)}\n\n"
        f"RECENT RELEVANT INCIDENT CHUNKS:\n{json.dumps([d.get('summary') or d.get('text', '') for d in context_docs], indent=2)}"
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
        "markdown_report": markdown_report
    }


def delete_pipeline_client(uid: str, client_id: str) -> bool:
    """Permanently delete a client from the pipeline."""
    try:
        res = pipeline_collection.delete_one({"_id": ObjectId(client_id), "uid": uid})
        return res.deleted_count > 0
    except Exception:
        return False
