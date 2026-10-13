export type ColorPalette = {
  label: string;
  secondaryLabel: string;
  separator: string;
  systemBackground: string;
  secondarySystemBackground: string;
  control: string;
  bg: string;
  bubble: string;
  sheet: string;
  card: string;
  line: string;
  text: string;
  muted: string;
  link: string;
  online: string;
  green: string;
  danger: string;
  /** Laid over a row or card while a finger is on it. */
  pressed: string;
};

export const darkColors: ColorPalette = {
  label: "#FFFFFF",
  secondaryLabel: "#8E8E93",
  separator: "#3A3A3C",
  systemBackground: "#000000",
  secondarySystemBackground: "#1C1C1E",
  control: "#2C2C2E",
  bg: "#000000",
  bubble: "#1C1C1E",
  sheet: "#161616",
  card: "#2A2A2C",
  line: "#3A3A3C",
  text: "#FFFFFF",
  muted: "#8E8E93",
  link: "#64B5FF",
  online: "#0A84FF",
  green: "#30D158",
  danger: "#FF453A",
  pressed: "rgba(255, 255, 255, 0.08)",
};

export const lightColors: ColorPalette = {
  label: "#000000",
  secondaryLabel: "#3C3C43",
  separator: "#C6C6C8",
  systemBackground: "#FFFFFF",
  secondarySystemBackground: "#F2F2F7",
  control: "#E5E5EA",
  bg: "#FFFFFF",
  bubble: "#F2F2F7",
  sheet: "#F2F2F7",
  card: "#FFFFFF",
  line: "#C6C6C8",
  text: "#000000",
  muted: "#3C3C43",
  link: "#007AFF",
  online: "#007AFF",
  green: "#34C759",
  danger: "#FF3B30",
  pressed: "rgba(0, 0, 0, 0.06)",
};

let active: ColorPalette = darkColors;
const listeners = new Set<(colors: ColorPalette) => void>();

/** Tells every screen to rebuild its styles with the palette now on screen. */
export function setActivePalette(next: ColorPalette): void {
  active = next;
  for (const listener of listeners) listener(next);
}

export function onPaletteChange(listener: (colors: ColorPalette) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Live palette. Reads during render follow the selected appearance.
 * StyleSheet values are rebuilt by onPaletteChange, because those are copied once.
 */
export const colors: ColorPalette = new Proxy({} as ColorPalette, {
  get(_target, prop: string) {
    return active[prop as keyof ColorPalette];
  },
});

export const palette = ["#7C5CFF", "#FF2D55", "#0A84FF", "#F2F2F7", "#2DD4BF", "#30D158", "#A78BFA", "#FF9F0A"];
