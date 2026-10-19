import { useEffect, useRef, useState } from "react";
import { Modal, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import * as Haptics from "expo-haptics";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { CircleButton } from "./CircleButton";
import { IconClose } from "./icons";

/** Converts HSL (h: 0-360, s: 0-100, l: 0-100) to hex string #RRGGBB */
export function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = light - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

/** Converts hex string to HSL (h: 0-360, s: 0-100, l: 0-100) */
export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const cleaned = hex.replace(/^#/, "");
  const full = cleaned.length === 3 ? cleaned.split("").map((c) => c + c).join("") : cleaned;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  if (isNaN(r) || isNaN(g) || isNaN(b)) return { h: 200, s: 100, l: 50 };
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h = Math.round(h * 60);
  }
  return { h, s: Math.round(s * 100), l: Math.round(l * 100) };
}

const QUICK_TONES = [
  "#FF3B30", "#FF9500", "#FFCC00", "#34C759", "#00C7BE",
  "#007AFF", "#5856D6", "#AF52DE", "#FF2D55", "#FFFFFF",
  "#8E8E93", "#1C1C1E",
];

const SLIDER_WIDTH = 270;
const SLIDER_HEIGHT = 28;

/**
 * Interactive color picker modal with smooth Hue, Saturation, and Lightness gradient sliders.
 */
export function ColorPickerModal({
  visible,
  color,
  onColorChange,
  onClose,
}: {
  visible: boolean;
  color: string;
  onColorChange: (hex: string) => void;
  onClose: () => void;
}) {
  const [hsl, setHsl] = useState(() => hexToHsl(color));
  const isDragging = useRef(false);
  const barLeftRef = useRef({ hue: 0, light: 0, sat: 0 });

  const currentHex = hslToHex(hsl.h, hsl.s, hsl.l);

  useEffect(() => {
    if (visible && !isDragging.current) {
      setHsl(hexToHsl(color));
    }
  }, [visible, color]);

  const update = (next: { h?: number; s?: number; l?: number }) => {
    setHsl((prev) => {
      const updated = { ...prev, ...next };
      const hex = hslToHex(updated.h, updated.s, updated.l);
      onColorChange(hex);
      return updated;
    });
  };

  // Hue slider pan responder
  const hueResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (evt) => {
        isDragging.current = true;
        const pageX = evt.nativeEvent.pageX;
        const locX = evt.nativeEvent.locationX;
        barLeftRef.current.hue = pageX - locX;
        const x = Math.max(0, Math.min(locX, SLIDER_WIDTH));
        const h = Math.round((x / SLIDER_WIDTH) * 360);
        update({ h });
      },
      onPanResponderMove: (evt) => {
        const x = Math.max(0, Math.min(evt.nativeEvent.pageX - barLeftRef.current.hue, SLIDER_WIDTH));
        const h = Math.round((x / SLIDER_WIDTH) * 360);
        update({ h });
      },
      onPanResponderRelease: () => {
        isDragging.current = false;
      },
      onPanResponderTerminate: () => {
        isDragging.current = false;
      },
    })
  ).current;

  // Lightness slider pan responder
  const lightResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (evt) => {
        isDragging.current = true;
        const pageX = evt.nativeEvent.pageX;
        const locX = evt.nativeEvent.locationX;
        barLeftRef.current.light = pageX - locX;
        const x = Math.max(0, Math.min(locX, SLIDER_WIDTH));
        const l = Math.round(5 + (x / SLIDER_WIDTH) * 90);
        update({ l });
      },
      onPanResponderMove: (evt) => {
        const x = Math.max(0, Math.min(evt.nativeEvent.pageX - barLeftRef.current.light, SLIDER_WIDTH));
        const l = Math.round(5 + (x / SLIDER_WIDTH) * 90);
        update({ l });
      },
      onPanResponderRelease: () => {
        isDragging.current = false;
      },
      onPanResponderTerminate: () => {
        isDragging.current = false;
      },
    })
  ).current;

  // Saturation slider pan responder
  const satResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (evt) => {
        isDragging.current = true;
        const pageX = evt.nativeEvent.pageX;
        const locX = evt.nativeEvent.locationX;
        barLeftRef.current.sat = pageX - locX;
        const x = Math.max(0, Math.min(locX, SLIDER_WIDTH));
        const s = Math.round((x / SLIDER_WIDTH) * 100);
        update({ s });
      },
      onPanResponderMove: (evt) => {
        const x = Math.max(0, Math.min(evt.nativeEvent.pageX - barLeftRef.current.sat, SLIDER_WIDTH));
        const s = Math.round((x / SLIDER_WIDTH) * 100);
        update({ s });
      },
      onPanResponderRelease: () => {
        isDragging.current = false;
      },
      onPanResponderTerminate: () => {
        isDragging.current = false;
      },
    })
  ).current;

  const hueX = (hsl.h / 360) * SLIDER_WIDTH;
  const lightX = ((hsl.l - 5) / 90) * SLIDER_WIDTH;
  const satX = (hsl.s / 100) * SLIDER_WIDTH;

  const pureHueHex = hslToHex(hsl.h, 100, 50);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.dialog} onPress={(e) => e.stopPropagation()}>
          <View style={styles.head}>
            <Text style={styles.title}>Pick a color</Text>
            <CircleButton label="Close" onPress={onClose}>
              <IconClose />
            </CircleButton>
          </View>

          {/* Large swatch and hex badge */}
          <View style={styles.previewRow}>
            <View style={[styles.bigSwatch, { backgroundColor: currentHex }]} />
            <View style={styles.hexBadge}>
              <Text style={styles.hexBadgeText}>{currentHex}</Text>
            </View>
          </View>

          {/* Hue slider */}
          <View style={styles.sliderSection}>
            <View style={styles.sliderLabelRow}>
              <Text style={styles.sliderLabel}>Hue</Text>
              <Text style={styles.sliderValue}>{hsl.h}°</Text>
            </View>
            <View style={styles.sliderContainer} {...hueResponder.panHandlers}>
              <Svg width={SLIDER_WIDTH} height={SLIDER_HEIGHT}>
                <Defs>
                  <LinearGradient id="hueGrad" x1="0" y1="0" x2="1" y2="0">
                    <Stop offset="0%" stopColor="#FF0000" />
                    <Stop offset="17%" stopColor="#FFFF00" />
                    <Stop offset="33%" stopColor="#00FF00" />
                    <Stop offset="50%" stopColor="#00FFFF" />
                    <Stop offset="67%" stopColor="#0000FF" />
                    <Stop offset="83%" stopColor="#FF00FF" />
                    <Stop offset="100%" stopColor="#FF0000" />
                  </LinearGradient>
                </Defs>
                <Rect x="0" y="0" width={SLIDER_WIDTH} height={SLIDER_HEIGHT} rx={14} fill="url(#hueGrad)" />
              </Svg>
              <View pointerEvents="none" style={[styles.thumb, { left: Math.max(0, Math.min(hueX - 14, SLIDER_WIDTH - 28)) }]} />
            </View>
          </View>

          {/* Lightness / Brightness slider */}
          <View style={styles.sliderSection}>
            <View style={styles.sliderLabelRow}>
              <Text style={styles.sliderLabel}>Brightness</Text>
              <Text style={styles.sliderValue}>{hsl.l}%</Text>
            </View>
            <View style={styles.sliderContainer} {...lightResponder.panHandlers}>
              <Svg width={SLIDER_WIDTH} height={SLIDER_HEIGHT}>
                <Defs>
                  <LinearGradient id="lightGrad" x1="0" y1="0" x2="1" y2="0">
                    <Stop offset="0%" stopColor="#000000" />
                    <Stop offset="50%" stopColor={pureHueHex} />
                    <Stop offset="100%" stopColor="#FFFFFF" />
                  </LinearGradient>
                </Defs>
                <Rect x="0" y="0" width={SLIDER_WIDTH} height={SLIDER_HEIGHT} rx={14} fill="url(#lightGrad)" />
              </Svg>
              <View pointerEvents="none" style={[styles.thumb, { left: Math.max(0, Math.min(lightX - 14, SLIDER_WIDTH - 28)) }]} />
            </View>
          </View>

          {/* Saturation slider */}
          <View style={styles.sliderSection}>
            <View style={styles.sliderLabelRow}>
              <Text style={styles.sliderLabel}>Saturation</Text>
              <Text style={styles.sliderValue}>{hsl.s}%</Text>
            </View>
            <View style={styles.sliderContainer} {...satResponder.panHandlers}>
              <Svg width={SLIDER_WIDTH} height={SLIDER_HEIGHT}>
                <Defs>
                  <LinearGradient id="satGrad" x1="0" y1="0" x2="1" y2="0">
                    <Stop offset="0%" stopColor="#808080" />
                    <Stop offset="100%" stopColor={pureHueHex} />
                  </LinearGradient>
                </Defs>
                <Rect x="0" y="0" width={SLIDER_WIDTH} height={SLIDER_HEIGHT} rx={14} fill="url(#satGrad)" />
              </Svg>
              <View pointerEvents="none" style={[styles.thumb, { left: Math.max(0, Math.min(satX - 14, SLIDER_WIDTH - 28)) }]} />
            </View>
          </View>

          {/* Quick tones */}
          <View style={styles.quickTones}>
            {QUICK_TONES.map((hex) => (
              <Pressable
                key={hex}
                accessibilityRole="button"
                accessibilityLabel={`Tone ${hex}`}
                onPress={() => {
                  const nextHsl = hexToHsl(hex);
                  setHsl(nextHsl);
                  onColorChange(hex);
                  if (process.env.EXPO_OS === "ios") {
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }
                }}
                style={styles.quickToneCell}
              >
                <View style={[styles.quickToneDot, { backgroundColor: hex }]} />
              </Pressable>
            ))}
          </View>

          <Pressable accessibilityRole="button" onPress={onClose} style={styles.doneButton}>
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function createStyles(theme: ColorPalette) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.65)",
      alignItems: "center",
      justifyContent: "center",
      padding: 20,
    },
    dialog: {
      width: 320,
      backgroundColor: theme.bg,
      borderRadius: 22,
      borderCurve: "continuous",
      padding: 20,
      gap: 16,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.4,
      shadowRadius: 24,
      elevation: 12,
    },
    head: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    title: { color: theme.text, fontSize: 18, fontWeight: "700" },
    previewRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 14,
      paddingVertical: 4,
    },
    bigSwatch: {
      width: 50,
      height: 50,
      borderRadius: 25,
      borderWidth: 2,
      borderColor: theme.line,
    },
    hexBadge: {
      backgroundColor: theme.control,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 12,
    },
    hexBadgeText: { color: theme.text, fontSize: 16, fontWeight: "700", letterSpacing: 1 },
    sliderSection: { gap: 6 },
    sliderLabelRow: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 2 },
    sliderLabel: { color: theme.muted, fontSize: 12, fontWeight: "600" },
    sliderValue: { color: theme.muted, fontSize: 12 },
    sliderContainer: {
      width: SLIDER_WIDTH,
      height: SLIDER_HEIGHT,
      borderRadius: 14,
      overflow: "visible",
      position: "relative",
      alignSelf: "center",
    },
    thumb: {
      position: "absolute",
      top: -2,
      width: 32,
      height: 32,
      borderRadius: 16,
      borderWidth: 3,
      borderColor: "#FFFFFF",
      backgroundColor: "transparent",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.5,
      shadowRadius: 4,
      elevation: 4,
    },
    quickTones: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      justifyContent: "center",
      marginTop: 2,
    },
    quickToneCell: { padding: 2 },
    quickToneDot: {
      width: 26,
      height: 26,
      borderRadius: 13,
      borderWidth: 1,
      borderColor: theme.line,
    },
    doneButton: {
      backgroundColor: theme.control,
      borderRadius: 12,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 4,
    },
    doneText: { color: theme.text, fontSize: 16, fontWeight: "600" },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
