"""
Graph service — manages persistent local Knowledge Graph for email entities.
Nodes: Sender, Email, Organization, Topic, ActionItem
Edges: SENT, BELONGS_TO, DISCUSSES, REQUIRES
"""

import json
import os
import re

from db import graph_collection

_graph_data = {
    "nodes": {},  # id -> {id, label, type, metadata}
    "edges": []   # [{source, target, relation}]
}


def load_graph():
    """Load persistent knowledge graph from MongoDB Atlas."""
    global _graph_data
    try:
        doc = graph_collection.find_one({"_id": "global_graph"})
        if doc:
            _graph_data = {
                "nodes": doc.get("nodes", {}),
                "edges": doc.get("edges", [])
            }
        else:
            _graph_data = {"nodes": {}, "edges": []}
    except Exception as e:
        print(f"[GraphStore] Error loading graph from MongoDB: {e}")
        _graph_data = {"nodes": {}, "edges": []}


def save_graph():
    """Save persistent knowledge graph to MongoDB Atlas."""
    try:
        graph_collection.update_one(
            {"_id": "global_graph"},
            {"$set": {"nodes": _graph_data["nodes"], "edges": _graph_data["edges"]}},
            upsert=True
        )
    except Exception as e:
        print(f"[GraphStore] Error saving graph to MongoDB: {e}")


def _clean_id(text: str) -> str:
    """Clean string to form a stable node ID."""
    return re.sub(r'[^a-zA-Z0-9_-]', '_', text.strip().lower())


def add_node(node_id: str, label: str, node_type: str, metadata: dict = None) -> str:
    """Add or update a node in the graph."""
    if not node_id or not label:
        return ""
    
    if node_id not in _graph_data["nodes"]:
        _graph_data["nodes"][node_id] = {
            "id": node_id,
            "label": label,
            "type": node_type,
            "metadata": metadata or {}
        }
    else:
        # Merge metadata
        if metadata:
            _graph_data["nodes"][node_id]["metadata"].update(metadata)
    return node_id


def add_edge(source_id: str, target_id: str, relation: str):
    """Add an edge if both nodes exist and edge doesn't already exist."""
    if not source_id or not target_id or source_id not in _graph_data["nodes"] or target_id not in _graph_data["nodes"]:
        return
    
    # Check duplicate
    for edge in _graph_data["edges"]:
        if edge["source"] == source_id and edge["target"] == target_id and edge["relation"] == relation:
            return
            
    _graph_data["edges"].append({
        "source": source_id,
        "target": target_id,
        "relation": relation
    })


def extract_org_from_email_address(email_addr: str) -> str:
    """Extract domain/company name from an email address (e.g., openai.com -> OpenAI)."""
    match = re.search(r'@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})', email_addr)
    if match:
        domain = match.group(1).lower()
        # Exclude common generic providers
        if domain not in ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com"]:
            company = domain.split('.')[0]
            return company.capitalize()
    return ""


def add_email_to_graph(
    message_id: str,
    subject: str,
    sender_raw: str,
    date: str,
    summary: str,
    uid: str,
    extracted_entities: dict = None
):
    """
    Incorporate an email and its extracted entities into the knowledge graph.
    """
    load_graph()

    # 1. Email Node
    email_node_id = f"email_{message_id}"
    add_node(
        node_id=email_node_id,
        label=subject[:40] if subject else "(No Subject)",
        node_type="email",
        metadata={
            "message_id": message_id,
            "subject": subject,
            "date": date,
            "summary": summary,
            "uid": uid
        }
    )

    # 2. Sender Node
    sender_name = sender_raw
    sender_id = f"sender_{_clean_id(sender_raw)}"
    add_node(
        node_id=sender_id,
        label=sender_name,
        node_type="sender",
        metadata={"raw": sender_raw, "uid": uid}
    )
    
    # Edge: Sender -> SENT -> Email
    add_edge(sender_id, email_node_id, "SENT")

    # 3. Organization Node (from domain or extraction)
    org_name = extract_org_from_email_address(sender_raw)
    if org_name:
        org_id = f"org_{_clean_id(org_name)}"
        add_node(org_id, org_name, "organization", metadata={"uid": uid})
        add_edge(sender_id, org_id, "BELONGS_TO")

    # 4. Process Extracted Entities (topics, organizations, action items)
    if extracted_entities:
        # Organizations
        for org in extracted_entities.get("organizations", []):
            if org and len(org.strip()) > 1:
                o_id = f"org_{_clean_id(org)}"
                add_node(o_id, org.strip(), "organization", metadata={"uid": uid})
                add_edge(email_node_id, o_id, "MENTIONS")

        # Topics / Concepts
        for topic in extracted_entities.get("topics", []):
            if topic and len(topic.strip()) > 1:
                t_id = f"topic_{_clean_id(topic)}"
                add_node(t_id, topic.strip(), "topic", metadata={"uid": uid})
                add_edge(email_node_id, t_id, "DISCUSSES")

        # Action Items
        for action in extracted_entities.get("action_items", []):
            if action and len(action.strip()) > 2:
                a_id = f"action_{_clean_id(action[:30])}"
                add_node(a_id, action.strip(), "action_item", metadata={"uid": uid})
                add_edge(email_node_id, a_id, "REQUIRES")

    save_graph()


def get_user_graph(uid: str = "") -> dict:
    """Return nodes and edges filtered for a specific user UID."""
    load_graph()
    
    if not uid:
        # Return all
        nodes_list = list(_graph_data["nodes"].values())
        return {"nodes": nodes_list, "edges": _graph_data["edges"]}

    # Filter nodes by UID
    valid_node_ids = set()
    filtered_nodes = []
    
    for n_id, node in _graph_data["nodes"].items():
        node_uid = node.get("metadata", {}).get("uid")
        if not node_uid or node_uid == uid:
            valid_node_ids.add(n_id)
            filtered_nodes.append(node)

    # Filter edges between valid nodes
    filtered_edges = [
        e for e in _graph_data["edges"]
        if e["source"] in valid_node_ids and e["target"] in valid_node_ids
    ]

    return {"nodes": filtered_nodes, "edges": filtered_edges}


def calculate_pagerank(nodes: list, edges: list, damping: float = 0.85, max_iter: int = 20) -> dict:
    """
    Compute iterative PageRank centrality scores for all nodes in the graph.
    Returns a dict mapping node_id -> normalized PageRank score (0.1 to 1.0 scale).
    """
    if not nodes:
        return {}

    node_ids = [n["id"] for n in nodes]
    N = len(node_ids)
    if N == 0:
        return {}

    # Initialize ranks uniformly
    pr = {nid: 1.0 / N for nid in node_ids}

    # Build graph adjacencies
    out_links = {nid: set() for nid in node_ids}
    in_links = {nid: set() for nid in node_ids}

    for edge in edges:
        src = edge.get("source")
        tgt = edge.get("target")
        if src in out_links and tgt in in_links:
            out_links[src].add(tgt)
            in_links[tgt].add(src)

    # Iterative calculation
    for _ in range(max_iter):
        new_pr = {}
        for nid in node_ids:
            rank_sum = 0.0
            for in_node in in_links[nid]:
                num_out = len(out_links[in_node])
                if num_out > 0:
                    rank_sum += pr[in_node] / num_out
            new_pr[nid] = (1.0 - damping) / N + damping * rank_sum
        pr = new_pr

    # Normalize max rank to 1.0 and min rank to 0.15 for UI scaling
    max_val = max(pr.values()) if pr else 1.0
    min_val = min(pr.values()) if pr else 0.0
    val_range = (max_val - min_val) if (max_val - min_val) > 1e-6 else 1.0

    normalized_pr = {}
    for nid, score in pr.items():
        norm_score = 0.2 + 0.8 * ((score - min_val) / val_range)
        normalized_pr[nid] = round(norm_score, 3)

    return normalized_pr


def calculate_edge_weights(edges: list) -> list:
    """
    Calculate dynamic edge strength weights based on relationship interaction volume.
    Returns enhanced list of edges with a 'weight' numeric property.
    """
    pair_counts = {}
    for edge in edges:
        src = edge.get("source")
        tgt = edge.get("target")
        pair_key = tuple(sorted([src, tgt]))
        pair_counts[pair_key] = pair_counts.get(pair_key, 0) + 1

    weighted_edges = []
    for edge in edges:
        src = edge.get("source")
        tgt = edge.get("target")
        pair_key = tuple(sorted([src, tgt]))
        count = pair_counts.get(pair_key, 1)
        weight = round(1.0 + (count - 1) * 0.5, 2)
        edge_copy = dict(edge)
        edge_copy["weight"] = weight
        weighted_edges.append(edge_copy)

    return weighted_edges


def detect_graph_anomalies(nodes: list, edges: list, pagerank_map: dict) -> list:
    """
    Detect structural anomalies and risk patterns in the Knowledge Graph:
    1. Stale High-Value Contact / Org
    2. Unresolved Action Item Bottlenecks
    3. High Convergence Topic Spikes
    """
    anomalies = []

    # Calculate degrees
    in_degree = {n["id"]: 0 for n in nodes}
    out_degree = {n["id"]: 0 for n in nodes}
    for e in edges:
        src = e.get("source")
        tgt = e.get("target")
        if src in out_degree:
            out_degree[src] += 1
        if tgt in in_degree:
            in_degree[tgt] += 1

    # 1. High PageRank Senders / Orgs with Low Connections
    for n in nodes:
        nid = n["id"]
        ntype = n.get("type")
        pr = pagerank_map.get(nid, 0.2)
        degree = in_degree.get(nid, 0) + out_degree.get(nid, 0)

        if ntype in ["sender", "organization"] and pr >= 0.6 and degree <= 1:
            anomalies.append({
                "id": f"anomaly_stale_{nid}",
                "type": "STALE_HIGH_VALUE_CONTACT",
                "severity": "HIGH",
                "title": f"Stale Key Contact: {n.get('label')}",
                "description": f"Entity '{n.get('label')}' has high PageRank centrality ({pr}) but is isolated with only {degree} touchpoint connection.",
                "target_node_id": nid
            })

    # 2. Action Item Bottlenecks
    for n in nodes:
        nid = n["id"]
        ntype = n.get("type")
        if ntype == "action_item":
            degree = in_degree.get(nid, 0) + out_degree.get(nid, 0)
            if degree >= 2 or "urgent" in n.get("label", "").lower() or "review" in n.get("label", "").lower():
                anomalies.append({
                    "id": f"anomaly_bottleneck_{nid}",
                    "type": "ACTION_BOTTLENECK",
                    "severity": "HIGH" if "urgent" in n.get("label", "").lower() else "MEDIUM",
                    "title": f"Action Bottleneck: {n.get('label')}",
                    "description": f"Requirement '{n.get('label')}' is linked across {degree} emails without verified completion.",
                    "target_node_id": nid
                })

    # 3. High Topic Convergence
    for n in nodes:
        nid = n["id"]
        ntype = n.get("type")
        if ntype == "topic":
            degree = in_degree.get(nid, 0)
            if degree >= 3:
                anomalies.append({
                    "id": f"anomaly_topic_spike_{nid}",
                    "type": "HIGH_CONVERGENCE_TOPIC",
                    "severity": "MEDIUM",
                    "title": f"Topic Spike: {n.get('label')}",
                    "description": f"Topic '{n.get('label')}' is referenced across {degree} separate emails, creating a dense cluster.",
                    "target_node_id": nid
                })

    return anomalies


def get_graph_analytics(uid: str = "") -> dict:
    """
    Return knowledge graph enhanced with PageRank centrality, weighted edges, and detected anomalies.
    """
    base_graph = get_user_graph(uid)
    nodes = base_graph.get("nodes", [])
    edges = base_graph.get("edges", [])

    pagerank_map = calculate_pagerank(nodes, edges)
    weighted_edges = calculate_edge_weights(edges)
    anomalies = detect_graph_anomalies(nodes, edges, pagerank_map)

    # Attach PageRank to nodes
    enhanced_nodes = []
    for n in nodes:
        n_copy = dict(n)
        n_copy["pagerank"] = pagerank_map.get(n["id"], 0.2)
        enhanced_nodes.append(n_copy)

    # Calculate top entities leaderboard
    sorted_nodes = sorted(enhanced_nodes, key=lambda x: x.get("pagerank", 0), reverse=True)
    top_entities = [
        {
            "id": n["id"],
            "label": n["label"],
            "type": n["type"],
            "pagerank": n["pagerank"]
        }
        for n in sorted_nodes[:7]
    ]

    return {
        "nodes": enhanced_nodes,
        "edges": weighted_edges,
        "pagerank": pagerank_map,
        "anomalies": anomalies,
        "top_entities": top_entities
    }


async def ask_graph(user_query: str, uid: str = "") -> dict:
    """
    Execute AI-powered Natural Language Graph Q&A ('Ask the Graph').
    Synthesizes graph analytics, PageRank scores, anomalies, and relationships into LLM answer.
    """
    from services import openai_service

    analytics = get_graph_analytics(uid)
    nodes = analytics["nodes"]
    edges = analytics["edges"]
    anomalies = analytics["anomalies"]
    top_entities = analytics["top_entities"]

    # Build context representation
    context_lines = []
    context_lines.append(f"Total Nodes: {len(nodes)} | Total Edges: {len(edges)}")
    
    context_lines.append("\nTop Central Entities (by PageRank Score):")
    for item in top_entities:
        context_lines.append(f"- [{item['type'].upper()}] {item['label']} (PageRank: {item['pagerank']})")

    context_lines.append("\nDetected Graph Anomalies & Risks:")
    if anomalies:
        for a in anomalies:
            context_lines.append(f"- [{a['severity']}] {a['title']}: {a['description']}")
    else:
        context_lines.append("- No critical anomalies detected.")

    context_lines.append("\nSample Graph Nodes & Metadata:")
    for n in nodes[:20]:
        meta = n.get("metadata", {})
        meta_str = f" | Summary: {meta.get('summary')[:80]}" if meta.get("summary") else ""
        context_lines.append(f"- ID: {n['id']} | Type: {n['type']} | Label: {n['label']}{meta_str}")

    context_lines.append("\nGraph Relationships:")
    for e in edges[:25]:
        context_lines.append(f"- {e['source']} --({e['relation']}, weight: {e.get('weight', 1.0)})--> {e['target']}")

    graph_context_text = "\n".join(context_lines)

    # Call OpenAI LLM for graph synthesis
    answer = await openai_service.query_graph_ai(user_query, graph_context_text)

    return {
        "query": user_query,
        "answer": answer,
        "anomalies_count": len(anomalies),
        "top_entity": top_entities[0]["label"] if top_entities else "N/A"
    }

