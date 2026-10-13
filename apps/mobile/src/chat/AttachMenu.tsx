import type { ComponentProps } from "react";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { Pressable, StyleSheet, Text } from "react-native";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { AdaptiveSurface } from "../ui/AdaptiveSurface";

type AttachIcon = "image" | "camera" | "folder";

type AttachAction = {
  icon: AttachIcon;
  label: string;
  onPress: () => void;
};

const ICONS: Record<AttachIcon, { sf: SymbolViewProps["name"]; md: ComponentProps<typeof MaterialIcons>["name"] }> = {
  image: { sf: "photo", md: "image" },
  camera: { sf: "camera", md: "photo-camera" },
  folder: { sf: "folder", md: "folder" },
};

function AttachIconView({ name }: { name: AttachIcon }) {
  const icon = ICONS[name];
  if (process.env.EXPO_OS === "ios") {
    return <SymbolView name={icon.sf} tintColor={colors.label} size={20} />;
  }
  return <MaterialIcons name={icon.md} size={20} color={colors.label as string} />;
}

/**
 * Floating attach menu anchored above the composer + button.
 * Why: matches native chat apps — dark glass card, icon + label rows.
 */
export function AttachMenu({ actions }: { actions: AttachAction[] }) {
  return (
    <AdaptiveSurface style={styles.menu}>
      {actions.map((action) => (
        <Pressable
          key={action.label}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={action.onPress}
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        >
          <AttachIconView name={action.icon} />
          <Text style={styles.label}>{action.label}</Text>
        </Pressable>
      ))}
    </AdaptiveSurface>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  menu: {
    borderRadius: 22,
    borderCurve: "continuous",
    paddingVertical: 6,
    minWidth: 220,
    boxShadow: "0 12px 24px rgba(0, 0, 0, 0.28)",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 13,
    paddingHorizontal: 18,
  },
  rowPressed: { backgroundColor: colors.pressed },
  label: { color: colors.text, fontSize: 17, fontWeight: "400" },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
