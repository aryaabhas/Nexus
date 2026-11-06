/**
 * API helper — all calls go through Vite's proxy to FastAPI on :8000
 */

const BASE = '/api';

async function apiFetch(path, options = {}) {
  const { headers, ...restOptions } = options;
  const isFormData = options.body instanceof FormData;
  const defaultHeaders = isFormData ? {} : { 'Content-Type': 'application/json' };
  
  const res = await fetch(`${BASE}${path}`, {
    ...restOptions,
    headers: {
      ...defaultHeaders,
      ...(headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const errorMsg = typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail || err);
    throw new Error(errorMsg || 'API error');
  }
  return res.json();
}

/** Verify the Firebase ID token with the backend */
export async function verifyToken(idToken) {
  return apiFetch('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ id_token: idToken }),
  });
}

/**
 * Fetch emails from Gmail.
 * @param {string} oauthToken  - Google OAuth2 access token
 * @param {string} idToken     - Firebase ID token (auth guard)
 * @param {string} [sender]    - Optional sender email to filter by
 * @param {number|null} [days] - Optional count of days filter
 * @param {string} [startDate] - Optional YYYY-MM-DD start date
 * @param {string} [endDate]   - Optional YYYY-MM-DD end date
 * @param {number} [maxResults=20]
 */
export async function fetchEmails(
  oauthToken,
  idToken,
  sender = '',
  days = null,
  startDate = '',
  endDate = '',
  maxResults = 20
) {
  return apiFetch('/emails/fetch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({
      oauth_token: oauthToken,
      sender,
      days: days ? parseInt(days, 10) : null,
      start_date: startDate || null,
      end_date: endDate || null,
      max_results: maxResults,
    }),
  });
}

/**
 * Summarize a list of emails and store them in FAISS.
 * @param {string[]} messageIds
 * @param {string} oauthToken
 * @param {string} idToken
 * @param {boolean} [force=false]
 */
export async function summarizeEmails(messageIds, oauthToken, idToken, force = false) {
  return apiFetch('/emails/summarize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ message_ids: messageIds, oauth_token: oauthToken, force }),
  });
}

/**
 * Delete a stored summary by messageId.
 * @param {string} messageId
 * @param {string} idToken
 */
export async function deleteSummary(messageId, idToken) {
  return apiFetch('/emails/delete_summary', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ message_id: messageId }),
  });
}

/**
 * Summarize a club/group of selected emails together into a single executive summary.
 * @param {string[]} messageIds
 * @param {string} oauthToken
 * @param {string} idToken
 */
export async function summarizeEmailClub(messageIds, oauthToken, idToken) {
  return apiFetch('/emails/summarize_club', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ message_ids: messageIds, oauth_token: oauthToken }),
  });
}

/**
 * Send an email with attachments to any specified recipient via Gmail API.
 * @param {string} oauthToken
 * @param {string} idToken
 * @param {string} to
 * @param {string} subject
 * @param {string} body
 * @param {File[]} [attachments]
 */
export async function sendEmail(oauthToken, idToken, to, subject, body, attachments = []) {
  const formData = new FormData();
  formData.append('oauth_token', oauthToken);
  formData.append('to', to);
  formData.append('subject', subject);
  formData.append('body', body);
  if (attachments && attachments.length > 0) {
    attachments.forEach((file) => {
      formData.append('attachments', file);
    });
  }

  return apiFetch('/emails/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
    body: formData,
  });
}

/** Get all stored summaries from FAISS metadata */
export async function getSummaries(idToken) {
  return apiFetch('/emails/summaries', {
    headers: { Authorization: `Bearer ${idToken}` },
  });
}

/**
 * Semantic search over stored email summaries.
 * @param {string} query
 * @param {string} idToken
 * @param {number} [k=5]
 */
export async function searchEmails(query, idToken, k = 5) {
  return apiFetch('/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ query, k }),
  });
}

/** Get Knowledge Graph nodes and edges */
export async function getKnowledgeGraph(idToken) {
  return apiFetch('/graph', {
    headers: { Authorization: `Bearer ${idToken}` },
  });
}

/** Get Knowledge Graph Analytics (nodes, edges, PageRank, anomalies) */
export async function getGraphAnalytics(idToken) {
  return apiFetch('/graph/analytics', {
    headers: { Authorization: `Bearer ${idToken}` },
  });
}

/** Ask natural language queries against Knowledge Graph structure */
export async function askGraph(query, idToken) {
  return apiFetch('/graph/ask', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ query }),
  });
}

/** Rebuild Knowledge Graph from existing stored email summaries */
export async function rebuildKnowledgeGraph(idToken) {
  return apiFetch('/graph/rebuild', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
  });
}


/** Get user activity/audit logs */
export async function getActivityLogs(idToken) {
  return apiFetch('/logs', {
    headers: { Authorization: `Bearer ${idToken}` },
  });
}

/** Check for replies on tracked email threads */
export async function getReplies(oauthToken, idToken) {
  return apiFetch('/emails/replies', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ oauth_token: oauthToken }),
  });
}

/** Dismiss reply notification for a thread */
export async function dismissReply(idToken, threadId) {
  return apiFetch('/emails/replies/dismiss', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ thread_id: threadId }),
  });
}

/** Get all messages in a specific thread */
export async function getThread(oauthToken, idToken, threadId) {
  return apiFetch('/emails/thread', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ oauth_token: oauthToken, thread_id: threadId }),
  });
}

/** Load user scratchpad content */
export async function getScratchpad(idToken) {
  return apiFetch('/emails/scratchpad', {
    headers: { Authorization: `Bearer ${idToken}` },
  });
}

/** Save user scratchpad content */
export async function saveScratchpad(idToken, content) {
  return apiFetch('/emails/scratchpad', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ content }),
  });
}

/** Fetch all stored documents from Cloudflare R2 */
export async function getR2Documents(idToken, direction = 'all', emailFilter = '') {
  const params = new URLSearchParams();
  if (direction && direction !== 'all') params.append('direction', direction);
  if (emailFilter) params.append('email_filter', emailFilter);
  const q = params.toString() ? `?${params.toString()}` : '';
  return apiFetch(`/emails/documents${q}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
}

/** Delete a document from Cloudflare R2 */
export async function deleteR2Document(idToken, key) {
  return apiFetch('/emails/documents', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ key }),
  });
}

/** Sync recent inbox attachments to Cloudflare R2 */
export async function syncR2InboxAttachments(oauthToken, idToken, maxEmails = 30) {
  return apiFetch('/emails/documents/sync_inbox', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ oauth_token: oauthToken, max_emails: maxEmails }),
  });
}

/** Log an unstructured natural language client incident */
export async function logPipelineIncident(idToken, text) {
  return apiFetch('/pipeline/incident', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ text }),
  });
}

/** Fetch full pipeline board (stages, clients, metrics) */
export async function getPipelineBoard(idToken) {
  return apiFetch('/pipeline/board', {
    headers: { Authorization: `Bearer ${idToken}` },
  });
}

/** Execute analytical sales query or generate executive pipeline report */
export async function queryPipeline(idToken, query) {
  return apiFetch('/pipeline/query', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ query }),
  });
}

/** Delete client from pipeline */
export async function deletePipelineClient(idToken, clientId) {
  return apiFetch(`/pipeline/client/${clientId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${idToken}` },
  });
}
