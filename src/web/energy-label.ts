// Pure (DOM-free) mapping of a 0..1 energy value to a human keyword + a
// cool→warm colour. The keyword is the accessible primary signal; colour
// is a secondary cue (never colour-alone). Unit-tested.

export interface EnergyLabel {
  label: string;
  color: string;
}

const NEUTRAL = "#8b93a7";

export function energyLabel(energy: number | null | undefined): EnergyLabel {
  if (energy == null || !Number.isFinite(energy)) {
    return { label: "—", color: NEUTRAL };
  }
  const e = Math.min(1, Math.max(0, energy));
  if (e < 0.25) return { label: "Chill", color: "#5b8def" };
  if (e < 0.5) return { label: "Groovy", color: "#38e0c4" };
  if (e < 0.75) return { label: "Energetic", color: "#ff8a3d" };
  return { label: "Peak", color: "#ff5a5a" };
}
