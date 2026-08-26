import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAgpLayout } from "../src/state/importers";
import { buildPafSyntenyPreview } from "../src/state/pafPreview";
import { buildReferenceSyntenyAllelePruning } from "../src/state/syntenyAllelePruning";

const agpPath = process.argv[2];
const pafPath = process.argv[3];
if (!agpPath || !pafPath) {
  throw new Error(
    "usage: vite-node scripts/export-paf-allele-truth.ts input.agp input.paf",
  );
}

const layout = parseAgpLayout(readFileSync(resolve(agpPath), "utf8"));
const paf = buildPafSyntenyPreview(readFileSync(resolve(pafPath), "utf8"));
const pruning = buildReferenceSyntenyAllelePruning(paf.records, layout.blocks, []);
const directEdges = pruning.alleleEdges.filter(
  (edge) => edge.confidence === "high" && edge.relationship === "allele",
);

console.log(JSON.stringify({
  method: {
    role: "Independent sequence-synteny proxy labels for the Hi-C benchmark only.",
    implementation: "buildReferenceSyntenyAllelePruning current defaults",
    positiveDefinition: "high-confidence direct PAF edge with relationship=allele",
    negativeDefinition: "both sources have accepted PAF anchors but no positive edge",
    unknownDefinition: "one or both sources lack an accepted PAF anchor",
  },
  inputs: {
    agpPath: resolve(agpPath),
    pafPath: resolve(pafPath),
    agpBlocks: layout.blocks.length,
    pafRecords: paf.records.length,
    ignoredPafLines: paf.ignoredLines,
  },
  anchors: pruning.anchors.map((anchor) => ({
    sourceId: anchor.sourceId,
    targetName: anchor.targetName,
    targetStart: anchor.targetStart,
    targetEnd: anchor.targetEnd,
    targetStrand: anchor.targetStrand,
    queryCoverage: anchor.queryCoverage,
    identity: anchor.identity,
    meanMapq: anchor.meanMapq,
    targetDominance: anchor.targetDominance,
  })),
  positiveEdges: directEdges.map((edge) => ({
    left: edge.left.sourceId,
    right: edge.right.sourceId,
    expectedOrientation: edge.left.targetStrand === edge.right.targetStrand
      ? "parallel"
      : "antiparallel",
    targetName: edge.targetName,
    overlapBp: edge.overlapBp,
    reciprocalTargetOverlap: edge.reciprocalTargetOverlap,
    minQueryCoverage: edge.minQueryCoverage,
    minIdentity: edge.minIdentity,
    minMeanMapq: edge.minMeanMapq,
    minTargetDominance: edge.minTargetDominance,
    confidenceScore: edge.confidenceScore,
  })),
  exclusions: pruning.exclusions.map((exclusion) => ({
    sourceId: exclusion.sourceId,
    reason: exclusion.reason,
  })),
  counts: {
    acceptedAnchors: pruning.anchors.length,
    positiveEdges: directEdges.length,
    excludedBlocks: pruning.excludedBlockCount,
    exclusionReasons: Object.fromEntries(
      [...new Set(pruning.exclusions.map((exclusion) => exclusion.reason))]
        .sort()
        .map((reason) => [
          reason,
          pruning.exclusions.filter((exclusion) => exclusion.reason === reason).length,
        ]),
    ),
  },
}, null, 2));
