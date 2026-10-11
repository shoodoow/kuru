import { useEffect, useState } from "react";
import { InteractionManager, View } from "react-native";
import {
  defaultGenderForStyle,
  defaultStyleForGender,
  markColorPresets,
  markStyles,
  normalizeMarkGender,
  normalizeMarkMaterial,
  normalizeMarkShape,
  normalizeMarkStyle,
  styleFitsMark,
  type MarkGender,
  type MarkMaterial,
  type MarkShape,
  type MarkStyle,
} from "@kuru/shared";
import { DotLive, DotThumb, isLiveMark, peekMarkThumb } from "./DotStage";

export type { MarkGender, MarkMaterial, MarkShape, MarkStyle };

export type MarkLook = {
  shape: MarkShape;
  color: string;
  material: MarkMaterial;
  style: MarkStyle;
  gender: MarkGender;
};

export type MarkMood = "idle" | "working";

/** Dot classics + cat + robot, in studio order. */
export const MARK_SHAPES: { id: MarkShape; label: string }[] = [
  { id: "round", label: "Round" },
  { id: "triangle", label: "Triangle" },
  { id: "pill", label: "Pill" },
  { id: "ears", label: "Ears" },
  { id: "cloud", label: "Cloud" },
  { id: "heart", label: "Heart" },
  { id: "butterfly", label: "Butterfly" },
  { id: "sprout", label: "Sprout" },
  { id: "scallop", label: "Scallop" },
  { id: "hexagon", label: "Hexagon" },
  { id: "diamond", label: "Diamond" },
  { id: "cat", label: "Cat" },
  { id: "robot", label: "Robot" },
];

/** Dot Avatar Maker color presets (shared with core surprise mark). */
export const MARK_COLORS: readonly string[] = markColorPresets;

/** Studio outfits (style tab later). */
export const MARK_STYLES: { id: MarkStyle; label: string }[] = markStyles.map((id) => ({
  id,
  label: id.charAt(0).toUpperCase() + id.slice(1),
}));

export const MARK_GENDERS: { id: MarkGender; label: string }[] = [
  { id: "male", label: "Boy" },
  { id: "female", label: "Girl" },
];

/** Dot finishes shown in the character picker. */
export const MARK_MATERIALS: { id: MarkMaterial; label: string }[] = [
  { id: "plush", label: "Short plush" },
  { id: "longfur", label: "Long plush" },
  { id: "felt", label: "Felt" },
  { id: "clay", label: "Clay" },
  { id: "ceramic", label: "Ceramic" },
  { id: "crackle", label: "Crackle" },
  { id: "stoneware", label: "Stoneware" },
  { id: "pearl", label: "Pearl" },
  { id: "vinyl", label: "Vinyl" },
  { id: "jelly", label: "Jelly" },
  { id: "glass", label: "Glass" },
  { id: "chrome", label: "Chrome" },
];

export const MARK_DEFAULT: MarkLook = {
  shape: "cloud",
  color: "#FFCC38",
  material: "plush",
  style: "minimal",
  gender: "male",
};

/** Saved mark fields with legacy defaults and studio gender/style compatibility. */
export function resolveMarkLook(fields: {
  markShape?: string | null;
  markColor?: string | null;
  markMaterial?: string | null;
  markStyle?: string | null;
  markGender?: string | null;
}): MarkLook {
  const shape = normalizeMarkShape(fields.markShape) ?? MARK_DEFAULT.shape;
  const color = fields.markColor ?? MARK_DEFAULT.color;
  const material = normalizeMarkMaterial(fields.markMaterial) ?? MARK_DEFAULT.material;
  let style = normalizeMarkStyle(fields.markStyle) ?? MARK_DEFAULT.style;
  let gender = normalizeMarkGender(fields.markGender) ?? defaultGenderForStyle(style);
  if (!styleFitsMark(style, gender)) style = defaultStyleForGender(gender);
  return { shape, color, material, style, gender };
}

/** Still Dot character from the studio baker (shape picker + lists). */
export function Mark({
  shape,
  color,
  size,
  material = "plush",
  style = MARK_DEFAULT.style,
  gender = MARK_DEFAULT.gender,
}: {
  shape: MarkShape;
  color: string;
  size: number;
  material?: MarkMaterial;
  style?: MarkStyle;
  gender?: MarkGender;
}) {
  return (
    <View accessibilityRole="image" accessibilityLabel={`${shape} ${material} mark`}>
      <DotThumb shape={shape} color={color} material={material} style={style} gender={gender} size={size} />
    </View>
  );
}

/**
 * Dot studio character: bakery PNG when small, live WebGL when large (same mesh/material).
 */
export function LivingMark({
  shape,
  color,
  size,
  material = "plush",
  style = MARK_DEFAULT.style,
  gender = MARK_DEFAULT.gender,
  mood = "idle",
}: {
  shape: MarkShape;
  color: string;
  size: number;
  material?: MarkMaterial;
  style?: MarkStyle;
  gender?: MarkGender;
  mood?: MarkMood;
  interactive?: boolean;
}) {
  const label = `${shape} ${material} mark${mood === "working" ? ", working" : ""}`;
  const look = { shape, color, material, style, gender };
  const [live, setLive] = useState(() => !isLiveMark(size) || !peekMarkThumb(look));

  useEffect(() => {
    if (!isLiveMark(size)) {
      setLive(false);
      return;
    }
    if (!peekMarkThumb(look)) {
      setLive(true);
      return;
    }
    setLive(false);
    const task = InteractionManager.runAfterInteractions(() => setLive(true));
    return () => task.cancel();
  }, [size, shape, color, material, style, gender]);

  return (
    <View accessibilityRole="image" accessibilityLabel={label}>
      {isLiveMark(size) && live ? (
        <DotLive shape={shape} color={color} material={material} style={style} gender={gender} size={size} />
      ) : (
        <DotThumb shape={shape} color={color} material={material} style={style} gender={gender} size={size} />
      )}
    </View>
  );
}
