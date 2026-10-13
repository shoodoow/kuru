import type { ComponentProps } from "react";
import Feather from "@expo/vector-icons/Feather";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { IconCheck } from "../ui/icons";

/**
 * Pointer and view options for the remote desktop viewer (trackpad vs direct touch, zoom).
 */
export function DesktopInputMenu({
  trackpad,
  onToggleTrackpad,
  onRecenterPointer,
  onResetZoom,
  onApprovals,
  onClose,
}: {
  trackpad: boolean;
  onToggleTrackpad: () => void;
  onRecenterPointer: () => void;
  onResetZoom: () => void;
  onApprovals: () => void;
  onClose: () => void;
}) {
  return (
    <View style={styles.menu}>
      <MenuRow
        label="Trackpad mode"
        icon="mouse-pointer"
        checked={trackpad}
        onPress={() => {
          onToggleTrackpad();
          onClose();
        }}
      />
      <MenuRow
        label="Recenter pointer"
        icon="crosshair"
        disabled={!trackpad}
        onPress={() => {
          onRecenterPointer();
          onClose();
        }}
      />
      <MenuRow
        label="Reset zoom"
        icon="minimize"
        onPress={() => {
          onResetZoom();
          onClose();
        }}
      />
      <View style={styles.divider} />
      <MenuRow
        label="Approvals"
        icon="check-circle"
        onPress={() => {
          onApprovals();
          onClose();
        }}
      />
    </View>
  );
}

/**
 * The two ways text moves between the phone and the agent's computer.
 * Input: what each row does, and how the menu closes. Output: the menu card.
 */
export function DesktopClipboardMenu({
  onToComputer,
  onToPhone,
  onClose,
}: {
  onToComputer: () => void;
  onToPhone: () => void;
  onClose: () => void;
}) {
  return (
    <View style={styles.menu}>
      <MenuRow
        label="Paste from phone"
        icon="upload"
        onPress={() => {
          onToComputer();
          onClose();
        }}
      />
      <MenuRow
        label="Copy to phone"
        icon="download"
        onPress={() => {
          onToPhone();
          onClose();
        }}
      />
    </View>
  );
}

function MenuRow({
  label,
  icon,
  checked,
  disabled,
  onPress,
}: {
  label: string;
  icon: ComponentProps<typeof Feather>["name"];
  checked?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ checked: checked ?? false, disabled: disabled ?? false }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && !disabled ? styles.rowPressed : null,
        disabled ? styles.rowDisabled : null,
      ]}
    >
      <View style={styles.checkSlot}>{checked ? <IconCheck /> : null}</View>
      <Feather name={icon} size={20} color={disabled ? colors.muted : colors.text} />
      <Text style={[styles.label, disabled ? styles.labelDisabled : null]}>{label}</Text>
    </Pressable>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  menu: {
    backgroundColor: "rgba(44, 44, 46, 0.94)",
    borderRadius: 22,
    borderCurve: "continuous",
    paddingVertical: 6,
    minWidth: 240,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.08)",
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 16,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 13,
    paddingHorizontal: 14,
  },
  rowPressed: { backgroundColor: "rgba(255, 255, 255, 0.08)" },
  rowDisabled: { opacity: 0.45 },
  checkSlot: { width: 22, alignItems: "center" },
  label: { color: colors.text, fontSize: 17, fontWeight: "400", flex: 1 },
  labelDisabled: { color: colors.muted },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255, 255, 255, 0.12)",
    marginHorizontal: 14,
    marginVertical: 4,
  },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
