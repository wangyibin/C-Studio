import type { GfaGraphEdge, GfaGraphNode } from "./gfa";

export interface GfaBandageLayoutRequest {
  nodes: Array<{
    id: string;
    width: number;
    orientation: GfaGraphNode["orientation"];
    layoutUnitId: string;
    layoutOrder: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
    sourceSide: "start" | "end";
    targetSide: "start" | "end";
  }>;
}

export interface GfaBandageLayoutResponse {
  algorithm: "cstudio-rust-multilevel-v1" | string;
  paths: Array<{
    id: string;
    points: Array<{ x: number; y: number }>;
  }>;
}

export type GfaBandageLayoutLoader = (
  request: GfaBandageLayoutRequest,
) => Promise<GfaBandageLayoutResponse>;

export function gfaBandageLayoutUnitId(
  node: Pick<GfaGraphNode, "id" | "groupId" | "assemblyBlockId">,
) {
  return node.assemblyBlockId
    ? `block:${JSON.stringify([node.groupId, node.assemblyBlockId])}`
    : `unitig:${node.id}`;
}

export function buildGfaBandageLayoutRequest(
  nodes: ReadonlyArray<GfaGraphNode>,
  edges: ReadonlyArray<GfaGraphEdge>,
  widths: ReadonlyMap<string, number>,
): GfaBandageLayoutRequest {
  const ids = new Set(nodes.map((node) => node.id));
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      width: widths.get(node.id) ?? 18,
      orientation: node.orientation,
      layoutUnitId: gfaBandageLayoutUnitId(node),
      layoutOrder: node.order,
    })),
    edges: edges.flatMap((edge) => (
      edge.kind === "gfa-link" && ids.has(edge.source) && ids.has(edge.target)
        ? [{
          source: edge.source,
          target: edge.target,
          sourceSide: edge.sourceSide ?? "end",
          targetSide: edge.targetSide ?? "start",
        }]
        : []
    )),
  };
}

export function gfaBandageLayoutRequestKey(
  request: GfaBandageLayoutRequest,
  revision = 0,
) {
  return [
    revision,
    ...request.nodes.map((node) => (
      `n:${node.id}:${node.width.toFixed(4)}:${node.orientation}:${node.layoutUnitId}:${node.layoutOrder}`
    )),
    ...request.edges.map((edge) => (
      `e:${edge.source}:${edge.sourceSide}:${edge.target}:${edge.targetSide}`
    )),
  ].join("\n");
}

export function validatedGfaBandagePathMap(
  response: GfaBandageLayoutResponse,
  expectedNodeIds: ReadonlySet<string>,
) {
  const paths = new Map<string, Array<{ x: number; y: number }>>();
  for (const path of response.paths) {
    if (!expectedNodeIds.has(path.id) || paths.has(path.id) || path.points.length < 2) {
      continue;
    }
    if (!path.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
      continue;
    }
    paths.set(path.id, path.points.map((point) => ({ x: point.x, y: point.y })));
  }
  if (paths.size !== expectedNodeIds.size) {
    throw new Error(
      `Rust GFA layout returned ${paths.size} of ${expectedNodeIds.size} node paths`,
    );
  }
  return paths;
}
