import { Command } from "commander";
import { join } from "path";
import { existsSync } from "fs";
import { loadConfig } from "../lib/config.js";
import { loadManifest, loadRelations, RELATION_TYPES, RelationType } from "../lib/manifest.js";
import { readText, writeText } from "../lib/files.js";

interface GraphNode {
  id: string;
  aliases: string[];
  sources: string[];
}

interface GraphEdge {
  from: string;
  to: string;
  type?: RelationType;
  evidence?: string;
  confidence?: number;
  conflictType?: string;
  needsReview?: boolean;
}

const EDGE_COLORS: Record<string, string> = {
  contradicts: "#e74c3c",
  cites: "#3498db",
  implements: "#27ae60",
  extends: "#27ae60",
  optimizes: "#27ae60",
  derived_from: "#27ae60",
  trades_off: "#27ae60",
  prerequisite_of: "#27ae60",
};

const DOT_EDGE_STYLES: Record<string, string> = {
  contradicts: 'style=dashed,color="#e74c3c"',
};

function getEdgeStyle(type?: RelationType): string {
  if (!type) return "";
  const style = DOT_EDGE_STYLES[type];
  if (style) return style;
  const color = EDGE_COLORS[type];
  return color ? `color="${color}"` : "";
}

export const graphCommand = new Command("graph")
  .description("Export concept graph as JSON, DOT, or HTML")
  .option("--format <fmt>", "Output format: json, dot, html", "json")
  .option("-o, --output <path>", "Write to file instead of stdout")
  .option("--relations <type>", `Filter edges by relation type: ${RELATION_TYPES.join(", ")}`)
  .action((opts) => {
    const dir = process.cwd();
    loadConfig(dir);
    const manifest = loadManifest(dir);
    const explicitRelations = loadRelations(dir);

    const knownSlugs = new Set(Object.keys(manifest.concepts));
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    for (const [slug, concept] of Object.entries(manifest.concepts)) {
      nodes.push({
        id: slug,
        aliases: concept.aliases,
        sources: concept.sources,
      });

      const articlePath = join(dir, concept.article_path);
      if (!existsSync(articlePath)) continue;

      const content = readText(articlePath);
      const wikilinks = content.match(/\[\[([^\]]+)\]\]/g) || [];
      for (const link of wikilinks) {
        const target = link.replace(/\[\[|\]\]/g, "").toLowerCase();
        if (knownSlugs.has(target) && target !== slug) {
          edges.push({ from: slug, to: target });
        }
      }
    }

    for (const r of explicitRelations) {
      edges.push({ 
        from: r.source, 
        to: r.target, 
        type: r.type, 
        evidence: r.evidence,
        confidence: (r as any).confidence,
        conflictType: (r as any).conflictType,
        needsReview: (r as any).needsReview,
      });
    }

    const filteredEdges = opts.relations
      ? edges.filter((e) => e.type === opts.relations)
      : edges;

    const uniqueEdges = filteredEdges.reduce<GraphEdge[]>((acc, e) => {
      const key = `${e.from}→${e.to}→${e.type || ""}`;
      if (!acc.find((a) => `${a.from}→${a.to}→${a.type || ""}` === key)) {
        acc.push(e);
      }
      return acc;
    }, []);

    let output: string;

    switch (opts.format) {
      case "dot":
        output = toDot(nodes, uniqueEdges);
        break;
      case "html":
        output = toHtml(nodes, uniqueEdges);
        break;
      default:
        output = JSON.stringify({ nodes, edges: uniqueEdges }, null, 2);
    }

    if (opts.output) {
      writeText(join(dir, opts.output), output);
      console.log(JSON.stringify({ ok: true, format: opts.format, output: opts.output, nodes: nodes.length, edges: uniqueEdges.length }));
    } else {
      console.log(output);
    }
  });

function toDot(nodes: GraphNode[], edges: GraphEdge[]): string {
  const lines = ["digraph wiki {", '  rankdir=LR;', '  node [shape=box, style=rounded];'];
  for (const n of nodes) {
    lines.push(`  "${n.id}";`);
  }
  for (const e of edges) {
    const style = getEdgeStyle(e.type);
    let label = "";
    if (e.type) {
      if (e.type === "contradicts" && e.confidence !== undefined) {
        label = `,label="${e.type} (${Math.round(e.confidence * 100)}%${e.conflictType ? ", " + e.conflictType : ""})"`;
      } else {
        label = `,label="${e.type}"`;
      }
    }
    if (style) {
      lines.push(`  "${e.from}" -> "${e.to}" [${style}${label}];`);
    } else {
      lines.push(`  "${e.from}" -> "${e.to}"${label ? ` [${label}]` : ""};`);
    }
  }
  lines.push("}");
  return lines.join("\n");
}

function toHtml(nodes: GraphNode[], edges: GraphEdge[]): string {
  const edgeColorMap = JSON.stringify(EDGE_COLORS);
  const graphData = JSON.stringify({ nodes, edges });
  return `<!DOCTYPE html>
<html>
<head>
  <title>Wiki Graph</title>
  <script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
  <style>body { margin: 0; } #graph { width: 100vw; height: 100vh; }</style>
</head>
<body>
  <div id="graph"></div>
  <script>
    const edgeColors = ${edgeColorMap};
    const data = ${graphData};
    const nodes = new vis.DataSet(data.nodes.map(n => ({ id: n.id, label: n.id })));
    const edges = new vis.DataSet(data.edges.map((e, i) => ({
      id: i,
      from: e.from,
      to: e.to,
      arrows: 'to',
      color: e.type ? { color: edgeColors[e.type] || '#888' } : { color: '#888' },
      dashes: e.type === 'contradicts',
      title: (e.type === 'contradicts' ? 'type: ' + e.type + (e.confidence ? '\\nconfidence: ' + Math.round(e.confidence * 100) + '%' : '') + (e.conflictType ? '\\nconflict: ' + e.conflictType : '') + (e.needsReview ? '\\nneeds review' : '') : e.type ? 'type: ' + e.type : '') + (e.evidence ? '\\n' + e.evidence : ''),
      label: e.type || undefined,
      font: { color: '#333', size: 10 }
    })));
    new vis.Network(document.getElementById('graph'), { nodes, edges }, {
      physics: { stabilization: { iterations: 200 } },
      nodes: { shape: 'box', margin: 10, font: { size: 14 } },
      edges: { smooth: { type: 'cubicBezier' } }
    });
  </script>
</body>
</html>`;
}
