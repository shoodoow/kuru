import { useEffect, useState, type ReactNode } from "react";
import { AccessibilityInfo, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import { colors } from "../theme/tokens";

/**
 * Draws a platform surface for controls the navigation stack does not own.
 * iOS uses Liquid Glass when the device has it, blur when it does not, and a
 * solid fill when Reduce Transparency is on. Android uses a Material tonal surface.
 */
export function AdaptiveSurface({
  children,
  style,
  interactive = false,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  interactive?: boolean;
}) {
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    // Only iOS has the setting, and only iOS draws a see-through surface.
    if (process.env.EXPO_OS !== "ios") return;
    let active = true;
    void AccessibilityInfo.isReduceTransparencyEnabled().then((enabled) => {
      if (active) setReduceTransparency(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceTransparencyChanged", setReduceTransparency);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  if (process.env.EXPO_OS !== "ios") {
    return (
      <View style={[{ backgroundColor: colors.control, borderCurve: "continuous" }, style]}>{children}</View>
    );
  }
  if (reduceTransparency) {
    return <View style={[{ backgroundColor: colors.systemBackground }, style]}>{children}</View>;
  }
  if (isLiquidGlassAvailable() && isGlassEffectAPIAvailable()) {
    return (
      <GlassView isInteractive={interactive} colorScheme="auto" style={style}>
        {children}
      </GlassView>
    );
  }
  return (
    <BlurView tint="systemMaterial" intensity={80} style={style}>
      {children}
    </BlurView>
  );
}

