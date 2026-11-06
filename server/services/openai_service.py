"""
LLM Service — Provider-agnostic intelligence for summarization, entity extraction, and RAG Q&A.
Supports seamless switching between OpenAI, OpenRouter, Groq, DeepSeek, Together, or any OpenAI-compatible endpoint.

Configuration via Environment Variables:
- LLM_MODEL: Model identifier (e.g. 'gpt-4o-mini', 'deepseek-chat', 'llama-3.3-70b-versatile', 'openai/gpt-4o-mini').
- LLM_BASE_URL: Optional custom API endpoint (e.g. 'https://api.groq.com/openai/v1', 'https://api.deepseek.com/v1').
- LLM_API_KEY: Provider API key (falls back to OPENAI_API_KEY).
"""

import os
from openai import AsyncOpenAI

_client: AsyncOpenAI | None = None
_client_config_hash: str | None = None


def get_llm_client_and_model() -> tuple[AsyncOpenAI, str]:
    """
    Returns a configured AsyncOpenAI client and model name based on environment variables.
    Allows changing LLM providers at any time without touching application code.
    """
    global _client, _client_config_hash

    api_key = os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("Neither LLM_API_KEY nor OPENAI_API_KEY environment variable is set.")

    custom_base_url = os.getenv("LLM_BASE_URL")
    custom_model = os.getenv("LLM_MODEL")

    # OpenRouter detection & defaults
    is_openrouter = api_key.startswith("sk-or-v1-")
    default_base_url = "https://openrouter.ai/api/v1" if is_openrouter else None
    base_url = custom_base_url or default_base_url

    # Model default
    if custom_model:
        model_name = custom_model
    elif is_openrouter:
        model_name = "openai/gpt-4o-mini"
    else:
        model_name = "gpt-4o-mini"

    # Re-initialize client if config changed
    config_hash = f"{api_key[-8:]}_{base_url}"
    if _client is None or _client_config_hash != config_hash:
        if base_url:
            _client = AsyncOpenAI(api_key=api_key, base_url=base_url)
        else:
            _client = AsyncOpenAI(api_key=api_key)
        _client_config_hash = config_hash

    return _client, model_name


def get_client() -> AsyncOpenAI:
    """Backward compatibility helper for get_client()."""
    client, _ = get_llm_client_and_model()
    return client


SUMMARIZE_SYSTEM_PROMPT = (
    "You are an expert email analyst. "
    "Summarise the following email in 2-3 concise bullet points. "
    "Focus on the key action items, decisions, or information. "
    "Be direct and avoid filler words. "
    "Reply ONLY with the bullet points, no preamble."
)


async def summarize_email(email_body: str, subject: str = "") -> str:
    """
    Summarise email content using the configured LLM model.
    Keeps token usage minimal by capping body length and limiting output tokens.
    """
    if not email_body.strip():
        return "No readable content found in this email."

    truncated_body = email_body[:2500]
    user_content = (
        f"Subject: {subject}\n\n{truncated_body}"
        if subject
        else truncated_body
    )

    client, model_name = get_llm_client_and_model()

    response = await client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": SUMMARIZE_SYSTEM_PROMPT},
            {"role": "user",   "content": user_content},
        ],
        max_tokens=150,
        temperature=0.3,
    )
    return response.choices[0].message.content.strip()


async def generate_subject_from_content(email_body: str, summary: str = "") -> str:
    """
    Generate a clear, professional subject line (4-8 words) based on the email body or summary
    when the original email has no subject.
    """
    client, model_name = get_llm_client_and_model()

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
        print(f"[LLMService] Failed to generate subject fallback: {e}")
        return "General Message"


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

    prompt_parts = []
    for idx, e in enumerate(emails_list, 1):
        subj = e.get("subject", "(No Subject)")
        sender = e.get("from", "Unknown")
        date = e.get("date", "")
        body = e.get("body", "")[:1200]
        prompt_parts.append(f"--- EMAIL {idx} ---\nFrom: {sender}\nDate: {date}\nSubject: {subj}\nContent:\n{body}\n")

    user_content = f"Synthesize these {len(emails_list)} emails into a single executive summary:\n\n" + "\n".join(prompt_parts)

    client, model_name = get_llm_client_and_model()

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

    client, model_name = get_llm_client_and_model()
    
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


async def answer_semantic_query(query: str, search_results: list[dict]) -> str:
    """
    RAG Synthesis: Generate a direct, synthesized executive answer to the user's
    search query based on the top semantic matches retrieved from Pinecone.
    """
    if not search_results:
        return ""

    context_snippets = []
    for idx, doc in enumerate(search_results[:5], 1):
        subj = doc.get("subject", "No Subject")
        sender = doc.get("from", "Unknown")
        dt = doc.get("date", "")
        summary = doc.get("summary", "")
        context_snippets.append(
            f"Email #{idx}:\n"
            f"- From: {sender}\n"
            f"- Date: {dt}\n"
            f"- Subject: {subj}\n"
            f"- Summary: {summary}"
        )

    context_str = "\n\n".join(context_snippets)
    client, model_name = get_llm_client_and_model()

    system_prompt = (
        "You are Nexus AI, an intelligent executive email assistant. "
        "The user asked a natural language search question over their emails. "
        "Using ONLY the provided email context snippets, give a direct, concise, and helpful answer (2 to 3 sentences max). "
        "Explicitly mention the sender name/email and date when referencing facts. "
        "If the specific detail or number was not found in the context, concisely state what the closest email discussed. "
        "Do not include conversational preamble like 'Certainly!' or 'Based on the context'."
    )

    user_prompt = f"Context from emails:\n{context_str}\n\nUser Question/Query: {query}"

    try:
        response = await client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_prompt},
            ],
            max_tokens=180,
            temperature=0.2,
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        print(f"[LLMService] Error generating RAG answer: {e}")
        return ""
