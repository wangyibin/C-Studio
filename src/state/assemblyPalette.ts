import { classifyGfaScaffolds } from "./gfaHomologLayout";

const homologPalette = [
  211, // blue
  28, // orange
  167, // teal
  352, // coral
  277, // violet
  46, // ochre
  326, // rose
  103, // green
  192, // cyan
  16, // warm brown
] as const;
// Sixteen first-class member colors support high-ploidy assemblies without
// cycling. Eight widely separated hues are paired with deliberately different
// lightness levels; adjacent g indices jump around the color wheel so small,
// intermingled Bandage nodes do not collapse into a sequential gradient.
// Chromosome groups rotate the complete member palette from their own base hue.
const homologMemberVariants = [
  { hueShift: 0, saturation: 76, lightness: 32 },
  { hueShift: 180, saturation: 70, lightness: 42 },
  { hueShift: 90, saturation: 64, lightness: 52 },
  { hueShift: 270, saturation: 76, lightness: 43 },
  { hueShift: 45, saturation: 82, lightness: 50 },
  { hueShift: 225, saturation: 68, lightness: 32 },
  { hueShift: 135, saturation: 62, lightness: 44 },
  { hueShift: 315, saturation: 74, lightness: 55 },
  { hueShift: 0, saturation: 64, lightness: 66 },
  { hueShift: 180, saturation: 58, lightness: 65 },
  { hueShift: 90, saturation: 55, lightness: 30 },
  { hueShift: 270, saturation: 60, lightness: 68 },
  { hueShift: 45, saturation: 70, lightness: 30 },
  { hueShift: 225, saturation: 60, lightness: 58 },
  { hueShift: 135, saturation: 72, lightness: 62 },
  { hueShift: 315, saturation: 66, lightness: 34 },
] as const;

export const unplacedAssemblyColor = "#94a3b8";

export function homologScaffoldColor(groupIndex: number, memberIndex: number) {
  const safeGroupIndex = Math.abs(Math.trunc(groupIndex));
  const safeMemberIndex = Math.abs(Math.trunc(memberIndex));
  const groupCycle = Math.floor(safeGroupIndex / homologPalette.length);
  const memberCycle = Math.floor(safeMemberIndex / homologMemberVariants.length);
  const groupHue = homologPalette[safeGroupIndex % homologPalette.length];
  const variant = homologMemberVariants[safeMemberIndex % homologMemberVariants.length];
  const hue = (groupHue + groupCycle * 17 + memberCycle * 11 + variant.hueShift) % 360;
  const lightnessOffset = memberCycle === 0
    ? 0
    : memberCycle % 2 === 1 ? 8 : -7;
  const lightness = Math.min(72, Math.max(28, variant.lightness + lightnessOffset));
  return `hsl(${hue} ${variant.saturation}% ${lightness}%)`;
}

export function assemblyScaffoldColorMap(
  scaffoldIds: readonly string[],
  homologPattern: string,
) {
  const homologs = classifyGfaScaffolds([...new Set(scaffoldIds)], homologPattern);
  const colors = new Map<string, string>();
  for (const [groupIndex, column] of homologs.columns.entries()) {
    for (const [memberIndex, scaffold] of column.scaffolds.entries()) {
      colors.set(scaffold.id, homologScaffoldColor(groupIndex, memberIndex));
    }
  }
  return colors;
}

export function defaultAssemblyScaffoldColor(scaffoldId: string, fallbackIndex: number) {
  const match = /^(?:Chr)(\d+)g(\d+)/i.exec(scaffoldId);
  const groupIndex = match ? Math.max(0, Number(match[1]) - 1) : fallbackIndex;
  const memberIndex = match ? Math.max(0, Number(match[2]) - 1) : 0;
  return homologScaffoldColor(groupIndex, memberIndex);
}
