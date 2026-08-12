import type { AssemblyChromosome } from "./assemblyEditing";

export const minimumAssemblyBoundaryObjectWidthPx = 3;
export const fallbackAssemblyBoundaryViewportWidthPx = 1_000;

interface AssemblyBoundaryViewport {
  xStart: number;
  xEnd: number;
}

export interface AssemblyBoundaryBand {
  id: string;
  visualStart: number;
  visualEnd: number;
  objectIds: string[];
  collapsed: boolean;
}

/**
 * Collapses only consecutive assembly objects that are narrower than the
 * current screen-space boundary threshold. The underlying chromosomes and
 * their hit targets remain untouched, and zooming in restores each boundary.
 */
export function buildAssemblyBoundaryBands(
  chromosomes: AssemblyChromosome[],
  viewport: AssemblyBoundaryViewport,
  viewportWidthPx = fallbackAssemblyBoundaryViewportWidthPx,
  minimumObjectWidthPx = minimumAssemblyBoundaryObjectWidthPx,
): AssemblyBoundaryBand[] {
  if (!Number.isFinite(viewport.xStart) || !Number.isFinite(viewport.xEnd)
    || viewport.xEnd <= viewport.xStart) {
    return [];
  }

  const span = viewport.xEnd - viewport.xStart;
  const safeViewportWidthPx = Number.isFinite(viewportWidthPx) && viewportWidthPx > 0
    ? viewportWidthPx
    : fallbackAssemblyBoundaryViewportWidthPx;
  const safeMinimumObjectWidthPx = Number.isFinite(minimumObjectWidthPx)
    ? Math.max(0, minimumObjectWidthPx)
    : minimumAssemblyBoundaryObjectWidthPx;
  const visible = [...chromosomes]
    .sort((left, right) => left.visualStart - right.visualStart || left.visualEnd - right.visualEnd)
    .filter((chromosome) => (
      chromosome.visualEnd > viewport.xStart && chromosome.visualStart < viewport.xEnd
    ));
  const bands: AssemblyBoundaryBand[] = [];
  let compactRun: AssemblyChromosome[] = [];

  const flushCompactRun = () => {
    if (compactRun.length === 0) {
      return;
    }
    bands.push(boundaryBandForChromosomes(compactRun));
    compactRun = [];
  };

  for (const chromosome of visible) {
    const objectWidthPx = (
      Math.max(0, chromosome.visualEnd - chromosome.visualStart) / span
    ) * safeViewportWidthPx;
    const compact = objectWidthPx < safeMinimumObjectWidthPx;
    if (!compact) {
      flushCompactRun();
      bands.push(boundaryBandForChromosomes([chromosome]));
      continue;
    }

    const previous = compactRun[compactRun.length - 1];
    const gapWidthPx = previous
      ? (Math.max(0, chromosome.visualStart - previous.visualEnd) / span) * safeViewportWidthPx
      : 0;
    if (previous && gapWidthPx >= safeMinimumObjectWidthPx) {
      flushCompactRun();
    }
    compactRun.push(chromosome);
  }
  flushCompactRun();

  return bands;
}

function boundaryBandForChromosomes(chromosomes: AssemblyChromosome[]): AssemblyBoundaryBand {
  const first = chromosomes[0];
  const last = chromosomes[chromosomes.length - 1];
  return {
    id: chromosomes.length === 1
      ? first.id
      : `${first.id}::${last.id}::${chromosomes.length}`,
    visualStart: first.visualStart,
    visualEnd: last.visualEnd,
    objectIds: chromosomes.map((chromosome) => chromosome.id),
    collapsed: chromosomes.length > 1,
  };
}
