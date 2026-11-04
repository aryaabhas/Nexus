"""
OpenAI service — email summarisation only.
Embeddings are handled locally by all-MiniLM-L6-v2 in vector_store.py.
"""

import os

from openai import AsyncOpenAI

_client: AsyncOpenAI | None = None


def get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY environment variable is not set.")
        
        # Automatically detect OpenRouter keys and configure base URL
        if api_key.startswith("sk-or-v1-"):
            _client = AsyncOpenAI(
                api_key=api_key,
                base_url="https://openrouter.ai/api/v1"
            )
        else:
            _client = AsyncOpenAI(api_key=api_key)
    return _client


SUMMARIZE_SYSTEM_PROMPT = (
    "You are an expert email analyst. "
    "Summarise the following email in 2-3 concise bullet points. "
    "Focus on the key action items, decisions, or information. "
    "Be direct and avoid filler words. "
    "Reply ONLY with the bullet points, no preamble."
)


async def summarize_email(email_body: str, subject: str = "") -> str:
    """
    Summarise email content using GPT-4o-mini.
    Keeps token usage minimal by capping body length and limiting output tokens.

    Returns a bullet-point summary string.
    """
    if not email_body.strip():
        return "No readable content found in this email."

    # Truncate to 2500 chars to limit input tokens (~625 tokens max for body)
    truncated_body = email_body[:2500]

    user_content = (
        f"Subject: {subject}\n\n{truncated_body}"
        if subject
        else truncated_body
    )

    client = get_client()
    
    # Use OpenRouter model name if using OpenRouter key
    api_key = os.getenv("OPENAI_API_KEY", "")
    model_name = "openai/gpt-4o-mini" if api_key.startswith("sk-or-v1-") else "gpt-4o-mini"
    
    response = await client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": SUMMARIZE_SYSTEM_PROMPT},
            {"role": "user",   "content": user_content},
        ],
        max_tokens=150,       # ~2-3 bullet points comfortably
        temperature=0.3,      # Low temp for consistent, factual summaries
    )
    return response.choices[0].message.content.strip()


async def generate_subject_from_content(email_body: str, summary: str = "") -> str:
    """
    Generate a clear, professional subject line (4-8 words) based on the email body or summary
    when the original email has no subject.
    """
    client = get_client()
    api_key = os.getenv("OPENAI_API_KEY", "")
    model_name = "openai/gpt-4o-mini" if api_key.startswith("sk-or-v1-") else "gpt-4o-mini"

    text_context = summary or email_body[:1000]
    if not text_context.strip():
        return "Untitled Communication"

    try:
        response = await client.chat.completions.create(
            model=model_name,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Generate a concise, professional email subject line (4 to 8 words maximum) "
                        "that accurately reflects the core message or request. "
                        "Do not include quotes, prefixes like 'Subject:', or punctuation at the end."
                    ),
                },
                {"role": "user", "content": text_context},
            ],
            max_tokens=25,
            temperature=0.3,
        )
        generated = response.choices[0].message.content.strip().replace('"', '').replace("'", "")
        return generated if generated else "General Message"
    except Exception as e:
        print(f"[OpenAI] Failed to generate subject fallback: {e}")
        return "General Message"


ENTITY_EXTRACTION_PROMPT = (
    "Extract structured entities from this email to build a Knowledge Graph. "
    "Respond ONLY with a valid JSON object matching this structure: "
    "{\n"
    '  "organizations": ["Company A", "Org B"],\n'
    '  "topics": ["Project X", "Billing", "Self Care"],\n'
    '  "action_items": ["Review document", "Call client"]\n'
    "}\n"
    "Limit each array to at most 3 relevant items. Keep entries short (1-4 words). "
    "Return JSON only, no code blocks or markdown."
)


async def extract_graph_entities(subject: str, summary: str, body: str = "") -> dict:
    """
    Extract structured topics, organizations, and action items for the Knowledge Graph.
    """
    content_sample = f"Subject: {subject}\nSummary: {summary}\nBody: {body[:800]}"
    client = get_client()
    
    api_key = os.getenv("OPENAI_API_KEY", "")
    model_name = "openai/gpt-4o-mini" if api_key.startswith("sk-or-v1-") else "gpt-4o-mini"
    
    try:
        response = await client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": ENTITY_EXTRACTION_PROMPT},
                {"role": "user",   "content": content_sample},
            ],
            max_tokens=150,
            temperature=0.1,
        )
        raw_json = response.choices[0].message.content.strip()
        # Clean JSON if model returned markdown codeblock
        if raw_json.startswith("```"):
            raw_json = raw_json.replace("```json", "").replace("```", "").strip()
        import json
        return json.loads(raw_json)
    except Exception as e:
        print(f"[GraphExtraction] Error extracting entities: {e}")
        return {"organizations": [], "topics": [], "action_items": []}


CLUB_SUMMARIZE_SYSTEM_PROMPT = (
    "You are an expert email thread analyst. "
    "You are given multiple emails that belong to the same topic or thread. "
    "Synthesize them into a single, cohesive executive summary. "
    "Structure your response with:\n"
    "• Overall Thread Topic & Context (1 sentence)\n"
    "• Key Decisions & Information (2-3 bullet points)\n"
    "• Action Items & Next Steps (if any)\n"
    "Be direct, highly concise, and clear. Reply ONLY with the summary bullets, no preamble."
)


async def summarize_email_club(emails_list: list[dict]) -> str:
    """
    Summarize a club/group of multiple emails into a single thread executive summary.
    """
    if not emails_list:
        return "No emails selected to summarize."

    # Format multi-email text payload
    prompt_parts = []
    for idx, e in enumerate(emails_list, 1):
        subj = e.get("subject", "(No Subject)")
        sender = e.get("from", "Unknown")
        date = e.get("date", "")
        body = e.get("body", "")[:1200]  # Cap each body to keep token usage minimal
        prompt_parts.append(f"--- EMAIL {idx} ---\nFrom: {sender}\nDate: {date}\nSubject: {subj}\nContent:\n{body}\n")

    user_content = f"Synthesize these {len(emails_list)} emails into a single executive summary:\n\n" + "\n".join(prompt_parts)

    client = get_client()
    api_key = os.getenv("OPENAI_API_KEY", "")
    model_name = "openai/gpt-4o-mini" if api_key.startswith("sk-or-v1-") else "gpt-4o-mini"

    response = await client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": CLUB_SUMMARIZE_SYSTEM_PROMPT},
            {"role": "user",   "content": user_content},
        ],
        max_tokens=250,
        temperature=0.3,
    )
    return response.choices[0].message.content.strip()


async def draft_persona_email(
    persona: str,
    product_description: str,
    additional_context: str = "",
    recipient_email: str = ""
) -> dict:
    """
    Generate an email subject and body based on product description and a specified persona.
    """
    system_prompt = (
        "You are an expert sales, HR, and technical communications copywriter. "
        "Your task is to draft a highly effective email based on the provided product/service description and style persona. "
        "Strictly adjust your content based on the target persona:\n"
        "- '👔 Business & ROI Focus': Target business owners/executors. Emphasize financial benefits, efficiency improvements, cost savings, and business scalability.\n"
        "- '⚙️ Technical Product Aspects': Target developers/CTOs/architects. Emphasize architecture, APIs, uptime SLAs, performance metrics, and code integration specifications.\n"
        "- '👥 HR & Hiring Alignment': Target HR managers/recruiters. Emphasize candidate matching, workforce productivity, employee onboarding, talent retention, and HR tools integration.\n"
        "- '🚨 Urgent Alert & Outreach': High priority, time-sensitive. Focus on service outages, immediate hotfixes, crisis communication, or response credits.\n"
        "- '☕ Casual Follow-up': Soft touchpoint, warm update.\n\n"
        "Respond ONLY with a valid JSON object matching this structure:\n"
        "{\n"
        '  "subject": "Email Subject Line Here",\n'
        '  "body": "Hi there,\\n\\n[Email content formatted with newlines]\\n\\nBest regards,\\n[Sender]"\n'
        "}\n"
        "Do not wrap the response in markdown or markdown code blocks (like ```json). Return raw JSON only."
    )
    
    user_prompt = (
        f"Style Persona: {persona}\n"
        f"Product/Service Description: {product_description}\n"
        f"Additional Context/Instructions: {additional_context}\n"
        f"Recipient Email (if any): {recipient_email}\n"
    )
    
    # Look up user profile from MongoDB to append signature if exists
    profile_data = {"name": "", "designation": "", "company_name": "", "phone_number": ""}
    try:
        from db import profiles_collection
        # Can query if uid or profile context available
    except Exception:
        pass

    client = get_client()
    
    api_key = os.getenv("OPENAI_API_KEY", "")
    model_name = "openai/gpt-4o-mini" if api_key.startswith("sk-or-v1-") else "gpt-4o-mini"
    
    response = await client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_prompt},
        ],
        temperature=0.7,
    )
    
    raw_json = response.choices[0].message.content.strip()
    if raw_json.startswith("```"):
        raw_json = raw_json.split("\n", 1)[1]
    if raw_json.endswith("```"):
        raw_json = raw_json.rsplit("\n", 1)[0]
    raw_json = raw_json.strip()
    
    import json
    parsed = json.loads(raw_json)
    return parsed


ASK_GRAPH_SYSTEM_PROMPT = (
    "You are an expert Graph Intelligence Assistant for NexusOpsCRM. "
    "You are provided with structured Knowledge Graph context (nodes, relationships, PageRank centrality scores, edge weights, and detected graph anomalies). "
    "Analyze the graph context to directly and insightfully answer the user's natural language question. "
    "Be concise, analytical, and actionable. Highlight specific entity names, organizations, PageRank standings, or anomaly risks where relevant."
)


async def query_graph_ai(user_query: str, graph_context_text: str) -> str:
    """
    Answer natural language queries about the Knowledge Graph structure, entities, and anomalies using GPT-4o-mini.
    """
    client = get_client()
    api_key = os.getenv("OPENAI_API_KEY", "")
    model_name = "openai/gpt-4o-mini" if api_key.startswith("sk-or-v1-") else "gpt-4o-mini"

    user_content = f"Question: {user_query}\n\nKnowledge Graph Context:\n{graph_context_text}"

    response = await client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": ASK_GRAPH_SYSTEM_PROMPT},
            {"role": "user",   "content": user_content},
        ],
        max_tokens=350,
        temperature=0.3,
    )
    return response.choices[0].message.content.strip()


