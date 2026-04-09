import { Command } from "commander";
import { join } from "path";
import { existsSync } from "fs";
import { loadConfig } from "../lib/config.js";
import { loadManifest } from "../lib/manifest.js";
import { readText, writeText } from "../lib/files.js";

interface GraphNode {
  id: string;
  aliases: string[];
  sources: string[];
}

interface GraphEdge {
  from: string;
  to: string;
}

export const graphCommand = new Command("graph")
  .description("Export concept graph as JSON, DOT, or HTML")
  .option("--format <fmt>", "Output format: json, dot, html", "json")
  .option("-o, --output <path>", "Write to file instead of stdout")
  .action((opts) => {
    const dir = process.cwd();
    const config = loadConfig(dir);
    const manifest = loadManifest(dir);

    const knownSlugs = new Set(Object.keys(manifest.concepts));
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    for (const [slug, concept] of Object.entries(manifest.concepts)) {
      nodes.push({
        id: slug,
        aliases: concept.aliases,
        sources: concept.sources,
      });

      // Parse wikilinks from article
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

    // Deduplicate edges
    const edgeSet = new Set(edges.map((e) => `${e.from}→${e.to}`));
    const uniqueEdges = [...edgeSet].map((e) => {
      const [from, to] = e.split("→");
      return { from, to };
    });

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
    lines.push(`  "${e.from}" -> "${e.to}";`);
  }
  lines.push("}");
  return lines.join("\n");
}

function toHtml(nodes: GraphNode[], edges: GraphEdge[]): string {
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
    const data = ${graphData};
    const nodes = new vis.DataSet(data.nodes.map(n => ({ id: n.id, label: n.id })));
    const edges = new vis.DataSet(data.edges.map((e, i) => ({ id: i, from: e.from, to: e.to, arrows: 'to' })));
    new vis.Network(document.getElementById('graph'), { nodes, edges }, {
      physics: { stabilization: { iterations: 200 } },
      nodes: { shape: 'box', margin: 10, font: { size: 14 } },
      edges: { color: '#888', smooth: { type: 'cubicBezier' } }
    });
  </script>
</body>
</html>`;
}
