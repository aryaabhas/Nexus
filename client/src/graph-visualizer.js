/**
 * Interactive 2D Canvas Force-Directed Graph Engine
 * Monochrome modern design system styling.
 */

export class GraphVisualizer {
  constructor(canvasElement, onNodeSelect) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.onNodeSelect = onNodeSelect;

    this.nodes = [];
    this.edges = [];
    this.nodeMap = new Map();

    // Physics parameters
    this.repulsion = 4500;
    this.stiffness = 0.04;
    this.damping = 0.85;
    this.minDistance = 30;

    // Viewport transform (pan & zoom)
    this.scale = 1;
    this.panX = 0;
    this.panY = 0;

    // Mouse tracking
    this.isDragging = false;
    this.draggedNode = null;
    this.isPanning = false;
    this.startMouseX = 0;
    this.startMouseY = 0;
    this.hoveredNode = null;
    this.selectedNode = null;

    // Node Type Config
    this.typeConfigs = {
      sender:       { icon: '👤', radius: 18, color: '#ffffff', label: 'Sender' },
      email:        { icon: '✉️', radius: 16, color: '#d4d4d8', label: 'Email' },
      organization: { icon: '🏢', radius: 20, color: '#e4e4e7', label: 'Organization' },
      topic:        { icon: '🏷️', radius: 15, color: '#a1a1aa', label: 'Topic' },
      action_item:  { icon: '⚡', radius: 15, color: '#ffffff', label: 'Action Item' }
    };

    // Category highlight colors for connections and partner nodes
    this.categoryColors = {
      sender: '#34d399',       // Green
      email: '#38bdf8',        // Blue
      organization: '#fb923c', // Orange
      topic: '#c084fc',        // Purple
      action_item: '#f43f5e'   // Rose
    };

    this.searchQuery = '';

    // Filter toggles
    this.activeFilters = new Set(['sender', 'email', 'organization', 'topic', 'action_item']);

    this._initEvents();
    this._startLoop();
  }

  setSearchQuery(query) {
    this.searchQuery = query || '';
  }

  setData(nodesData, edgesData, anomaliesData = []) {
    this.nodeMap.clear();
    const width = this.canvas.width || 800;
    const height = this.canvas.height || 600;

    this.anomalyNodeIds = new Set(anomaliesData.map(a => a.target_node_id).filter(Boolean));

    // Initialize positions in a circle around center
    this.nodes = nodesData.map((n, idx) => {
      const angle = (idx / nodesData.length) * Math.PI * 2;
      const radius = 150 + Math.random() * 80;
      const node = {
        ...n,
        x: (width / 2) + Math.cos(angle) * radius,
        y: (height / 2) + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        type: n.type || 'topic',
        pagerank: n.pagerank || 0.2
      };
      this.nodeMap.set(n.id, node);
      return node;
    });

    this.edges = edgesData
      .map(e => ({
        source: this.nodeMap.get(e.source),
        target: this.nodeMap.get(e.target),
        relation: e.relation || '',
        weight: e.weight || 1.0
      }))
      .filter(e => e.source && e.target);

    this.selectedNode = null;
    this.hoveredNode = null;
  }

  panToNode(target) {
    let targetNode = target;
    if (typeof target === 'string') {
      targetNode = this.nodeMap.get(target);
    }
    if (!targetNode) return;

    const width = this.width || 800;
    const height = this.height || 550;
    this.selectedNode = targetNode;
    this.scale = 1.3;
    this.panX = (width / 2) - targetNode.x * this.scale;
    this.panY = (height / 2) - targetNode.y * this.scale;
    if (this.onNodeSelect) this.onNodeSelect(targetNode);
  }

  setFilter(type, active) {
    if (active) {
      this.activeFilters.add(type);
    } else {
      this.activeFilters.delete(type);
    }
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = (rect.height || 550) * dpr;
    this.ctx.scale(dpr, dpr);
    this.width = rect.width;
    this.height = rect.height || 550;
  }

  _initEvents() {
    window.addEventListener('resize', () => this.resize());
    setTimeout(() => this.resize(), 50);

    const c = this.canvas;

    c.addEventListener('mousedown', (e) => {
      const pos = this._getCanvasCoords(e);
      const hitNode = this._getNodeAt(pos.x, pos.y);

      if (hitNode) {
        this.isDragging = true;
        this.draggedNode = hitNode;
        this.selectedNode = hitNode;
        if (this.onNodeSelect) this.onNodeSelect(hitNode);
      } else {
        this.isPanning = true;
        this.startMouseX = e.clientX - this.panX;
        this.startMouseY = e.clientY - this.panY;
        this.selectedNode = null;
        if (this.onNodeSelect) this.onNodeSelect(null);
      }
    });

    c.addEventListener('mousemove', (e) => {
      const pos = this._getCanvasCoords(e);

      if (this.isDragging && this.draggedNode) {
        this.draggedNode.x = pos.x;
        this.draggedNode.y = pos.y;
        this.draggedNode.vx = 0;
        this.draggedNode.vy = 0;
      } else if (this.isPanning) {
        this.panX = e.clientX - this.startMouseX;
        this.panY = e.clientY - this.startMouseY;
      } else {
        const hit = this._getNodeAt(pos.x, pos.y);
        this.hoveredNode = hit;
        c.style.cursor = hit ? 'pointer' : 'default';
      }
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
      this.draggedNode = null;
      this.isPanning = false;
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      const newScale = Math.max(0.3, Math.min(3, this.scale * zoomFactor));

      const rect = c.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      this.panX = mouseX - (mouseX - this.panX) * (newScale / this.scale);
      this.panY = mouseY - (mouseY - this.panY) * (newScale / this.scale);
      this.scale = newScale;
    }, { passive: false });
  }

  _getCanvasCoords(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    return {
      x: (mouseX - this.panX) / this.scale,
      y: (mouseY - this.panY) / this.scale
    };
  }

  _getNodeAt(x, y) {
    const visibleNodes = this.nodes.filter(n => this.activeFilters.has(n.type));
    for (let i = visibleNodes.length - 1; i >= 0; i--) {
      const n = visibleNodes[i];
      const cfg = this.typeConfigs[n.type] || this.typeConfigs.topic;
      const radius = cfg.radius * (n.pagerank ? Math.max(0.85, Math.min(1.8, n.pagerank * 1.4)) : 1.0);
      const dx = n.x - x;
      const dy = n.y - y;
      if (Math.sqrt(dx * dx + dy * dy) <= radius + 6) {
        return n;
      }
    }
    return null;
  }

  _stepPhysics() {
    const visibleNodes = this.nodes.filter(n => this.activeFilters.has(n.type));
    const cx = (this.width || 800) / 2;
    const cy = (this.height || 550) / 2;

    // 1. Repulsion between all node pairs
    for (let i = 0; i < visibleNodes.length; i++) {
      const n1 = visibleNodes[i];
      for (let j = i + 1; j < visibleNodes.length; j++) {
        const n2 = visibleNodes[j];
        let dx = n2.x - n1.x;
        let dy = n2.y - n1.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;

        if (dist < 300) {
          const force = this.repulsion / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          if (n1 !== this.draggedNode) { n1.vx -= fx; n1.vy -= fy; }
          if (n2 !== this.draggedNode) { n2.vx += fx; n2.vy += fy; }
        }
      }

      // Gravity towards center
      if (n1 !== this.draggedNode) {
        n1.vx += (cx - n1.x) * 0.002;
        n1.vy += (cy - n1.y) * 0.002;
      }
    }

    // 2. Attraction along edges
    const visibleEdges = this.edges.filter(
      e => this.activeFilters.has(e.source.type) && this.activeFilters.has(e.target.type)
    );

    for (const edge of visibleEdges) {
      const n1 = edge.source;
      const n2 = edge.target;
      const dx = n2.x - n1.x;
      const dy = n2.y - n1.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;

      const force = (dist - 100) * this.stiffness;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      if (n1 !== this.draggedNode) { n1.vx += fx; n1.vy += fy; }
      if (n2 !== this.draggedNode) { n2.vx -= fx; n2.vy -= fy; }
    }

    // 3. Update positions with damping
    for (const n of visibleNodes) {
      if (n === this.draggedNode) continue;
      n.vx *= this.damping;
      n.vy *= this.damping;
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  _startLoop() {
    const loop = () => {
      this._stepPhysics();
      this._render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  _render() {
    const ctx = this.ctx;
    const width = this.width || this.canvas.width;
    const height = this.height || this.canvas.height;

    ctx.clearRect(0, 0, width, height);

    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.scale, this.scale);

    const visibleNodes = this.nodes.filter(n => this.activeFilters.has(n.type));
    const visibleNodeSet = new Set(visibleNodes.map(n => n.id));
    const visibleEdges = this.edges.filter(
      e => visibleNodeSet.has(e.source.id) && visibleNodeSet.has(e.target.id)
    );

    // Resolve search query matches & direct neighbors
    const searchActiveNodes = new Set();
    const searchActiveEdges = new Set();
    const query = this.searchQuery.toLowerCase().trim();

    if (query.length > 0) {
      const queryWords = query.split(/\s+/).filter(w => w.length > 1);
      const matches = visibleNodes.filter(n => {
        const labelLower = (n.label || '').toLowerCase();
        const subjectLower = (n.metadata && n.metadata.subject || '').toLowerCase();
        const summaryLower = (n.metadata && n.metadata.summary || '').toLowerCase();

        if (labelLower.includes(query) || subjectLower.includes(query) || summaryLower.includes(query)) {
          return true;
        }

        if (queryWords.length > 0) {
          return queryWords.some(word => 
            labelLower.includes(word) || subjectLower.includes(word) || summaryLower.includes(word)
          );
        }
        return false;
      });

      matches.forEach(matchNode => {
        searchActiveNodes.add(matchNode.id);
        visibleEdges.forEach(e => {
          if (e.source.id === matchNode.id || e.target.id === matchNode.id) {
            const partner = (e.source.id === matchNode.id) ? e.target : e.source;
            searchActiveNodes.add(partner.id);
            searchActiveEdges.add(`${e.source.id}-${e.target.id}`);
            searchActiveEdges.add(`${e.target.id}-${e.source.id}`);
          }
        });
      });
    }

    const isSearching = query.length > 0 && searchActiveNodes.size > 0;

    // ── Render Edges ─────────────────────────────────────────
    const activeNode = this.hoveredNode || this.selectedNode;

    for (const edge of visibleEdges) {
      const isConnectedToSelected = this.selectedNode &&
        (edge.source.id === this.selectedNode.id || edge.target.id === this.selectedNode.id);
      
      const isConnectedToHovered = this.hoveredNode &&
        (edge.source.id === this.hoveredNode.id || edge.target.id === this.hoveredNode.id);

      const inSearchActive = !isSearching || searchActiveEdges.has(`${edge.source.id}-${edge.target.id}`);

      ctx.beginPath();
      ctx.moveTo(edge.source.x, edge.source.y);
      ctx.lineTo(edge.target.x, edge.target.y);

      const edgeWeightFactor = Math.min(3.0, edge.weight || 1.0);

      if (isConnectedToSelected || isConnectedToHovered) {
        // Highlight active connection with category-specific color of the partner node
        const partner = (edge.source.id === activeNode.id) ? edge.target : edge.source;
        ctx.strokeStyle = this.categoryColors[partner.type] || '#ffffff';
        ctx.lineWidth = 2.5 * edgeWeightFactor;
      } else if (inSearchActive) {
        ctx.strokeStyle = '#27272a';
        ctx.lineWidth = 1.0 * edgeWeightFactor;
      } else {
        // Faded edge (does not match search result)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
        ctx.lineWidth = 0.5;
      }
      ctx.stroke();

      // Render edge label on hover/select
      if ((isConnectedToSelected || isConnectedToHovered) && inSearchActive) {
        const partner = (edge.source.id === activeNode.id) ? edge.target : edge.source;
        const color = this.categoryColors[partner.type] || '#ffffff';
        const mx = (edge.source.x + edge.target.x) / 2;
        const my = (edge.source.y + edge.target.y) / 2;
        ctx.fillStyle = '#18181b';
        ctx.fillRect(mx - 24, my - 9, 48, 18);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(mx - 24, my - 9, 48, 18);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(edge.relation, mx, my);
      }
    }

    // ── Render Nodes ─────────────────────────────────────────
    for (const n of visibleNodes) {
      const isSelected = this.selectedNode && this.selectedNode.id === n.id;
      const isHovered = this.hoveredNode && this.hoveredNode.id === n.id;
      const inSearchActive = !isSearching || searchActiveNodes.has(n.id);

      ctx.globalAlpha = inSearchActive ? 1.0 : 0.15;

      const cfg = this.typeConfigs[n.type] || this.typeConfigs.topic;
      const prScale = n.pagerank ? Math.max(0.85, Math.min(1.8, n.pagerank * 1.4)) : 1.0;
      const nodeRadius = cfg.radius * prScale;

      // Find if this node is connected to the hovered/selected node
      let isPartnerNode = false;
      if (activeNode && n.id !== activeNode.id) {
        isPartnerNode = visibleEdges.some(e => 
          (e.source.id === activeNode.id && e.target.id === n.id) ||
          (e.target.id === activeNode.id && e.source.id === n.id)
        );
      }

      // Glow / Selection ring
      if (isSelected || isHovered) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, nodeRadius + 6, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? 'rgba(255, 255, 255, 0.2)' : 'rgba(255, 255, 255, 0.1)';
        ctx.fill();
      } else if (isPartnerNode && inSearchActive) {
        // Render partner categorization glow ring
        ctx.beginPath();
        ctx.arc(n.x, n.y, nodeRadius + 6, 0, Math.PI * 2);
        ctx.fillStyle = (this.categoryColors[n.type] || '#ffffff') + '33'; // 20% opacity
        ctx.fill();
      }

      // Outer Circle
      ctx.beginPath();
      ctx.arc(n.x, n.y, nodeRadius, 0, Math.PI * 2);
      ctx.fillStyle = '#121215';
      ctx.fill();
      
      let borderStrokeColor = '#27272a';
      if (isSelected) borderStrokeColor = '#ffffff';
      else if (isHovered) borderStrokeColor = '#e4e4e7';
      else if (isPartnerNode && inSearchActive) borderStrokeColor = this.categoryColors[n.type];

      ctx.strokeStyle = borderStrokeColor;
      ctx.lineWidth = isSelected ? 2.5 : (isPartnerNode && inSearchActive ? 2.0 : 1.5);
      ctx.stroke();

      // Icon Inside Node
      ctx.fillStyle = '#ffffff';
      ctx.font = `${nodeRadius * 0.9}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(cfg.icon, n.x, n.y);

      // Anomaly Alert Badge (⚠️) if flagged
      if (this.anomalyNodeIds && this.anomalyNodeIds.has(n.id)) {
        ctx.beginPath();
        ctx.arc(n.x + nodeRadius * 0.7, n.y - nodeRadius * 0.7, 9, 0, Math.PI * 2);
        ctx.fillStyle = '#ef4444';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('!', n.x + nodeRadius * 0.7, n.y - nodeRadius * 0.7);
      }

      // Node Label Below
      ctx.fillStyle = isSelected || isHovered ? '#ffffff' : (isPartnerNode && inSearchActive ? '#ffffff' : '#a1a1aa');
      ctx.font = `${isSelected || (isPartnerNode && inSearchActive) ? '600' : '400'} 11px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const truncatedLabel = n.label.length > 18 ? n.label.slice(0, 16) + '…' : n.label;
      ctx.fillText(truncatedLabel, n.x, n.y + nodeRadius + 6);
      
      ctx.globalAlpha = 1.0;
    }

    ctx.restore();
  }
}

