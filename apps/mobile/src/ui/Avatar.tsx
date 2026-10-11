import { memo, useEffect, useRef, type ReactNode } from "react";
import { Image } from "expo-image";
import { Animated, Easing, Text, View } from "react-native";
import { isLiveMark } from "./DotStage";
import { LivingMark, Mark, resolveMarkLook, type MarkMood } from "./Mark";
import { palette } from "../theme/tokens";

/**
 * Picks a stable face color for one agent.
 * Why: exported so chat name labels match avatar faces per author.
 * Input: the agent id.
 * Output: a hex color from the roster palette.
 */
export function colorFor(id: string): string {
  let hash = 0;
  for (const char of id) {
    hash = (hash + char.charCodeAt(0)) % palette.length;
  }
  return palette[hash] ?? palette[0];
}

/** First letters of the signed-in name, or a single mark when the name is empty. */
function initials(label?: string): string {
  const parts = (label ?? "").trim().split(/\s+/).filter(Boolean);
  const letters = parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return letters || "?";
}

/** How much of its square the character fills. The rest is breathing room. */
const MARK_FILL = 0.9;

/**
 * Makes a small mark look busy: a soft bob and squash while the agent works.
 * Why: small marks are baked pictures, and a live 3D view per avatar is what
 * made lists crawl. This runs on the native animation thread, so it costs the
 * JS thread nothing, and it stops (and resets) the moment the work ends.
 */
function WorkingPulse({ active, children }: { active: boolean; children: ReactNode }) {
  const beat = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) {
      beat.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(beat, { toValue: 1, duration: 520, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(beat, { toValue: 0, duration: 520, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, beat]);
  if (!active) return <>{children}</>;
  return (
    <Animated.View
      style={{
        transform: [
          { translateY: beat.interpolate({ inputRange: [0, 1], outputRange: [0, -2] }) },
          { scaleX: beat.interpolate({ inputRange: [0, 1], outputRange: [1, 0.96] }) },
          { scaleY: beat.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }) },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}

type AvatarProps = {
  id: string;
  size: number;
  round?: boolean;
  person?: boolean;
  /** Signed-in name. The person badge shows initials from this. */
  label?: string;
  shape?: string | null;
  color?: string | null;
  material?: string | null;
  style?: string | null;
  gender?: string | null;
  photo?: string | null;
  mood?: MarkMood;
  alive?: boolean;
  interactive?: boolean;
};

function AvatarInner({
  id,
  size,
  round = false,
  person = false,
  label,
  shape = null,
  color = null,
  material = null,
  style = null,
  gender = null,
  photo = null,
  mood = "idle",
  alive = true,
}: AvatarProps) {
  // An agent's own picture, or the person's picture from their Google account (always a circle).
  if (photo) {
    return (
      <Image
        source={{ uri: photo }}
        contentFit="cover"
        style={{ width: size, height: size, borderRadius: round || person ? size / 2 : size * 0.32 }}
      />
    );
  }
  if (!person) {
    const look = resolveMarkLook({
      markShape: shape,
      markColor: color,
      markMaterial: material,
      markStyle: style,
      markGender: gender,
    });
    const markSize = Math.round(size * MARK_FILL);
    const frame = { width: size, height: size, alignItems: "center" as const, justifyContent: "center" as const };
    if (alive && isLiveMark(size)) {
      return (
        <View style={frame}>
          <LivingMark
            shape={look.shape}
            color={look.color}
            material={look.material}
            style={look.style}
            gender={look.gender}
            size={markSize}
            mood={mood}
          />
        </View>
      );
    }
    return (
      <View style={frame}>
        <WorkingPulse active={mood === "working"}>
          <Mark
            shape={look.shape}
            color={look.color}
            material={look.material}
            style={look.style}
            gender={look.gender}
            size={markSize}
          />
        </WorkingPulse>
      </View>
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colorFor(id),
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: "#FFFFFF", fontSize: Math.max(12, Math.round(size * 0.38)), fontWeight: "600" }}>{initials(label)}</Text>
    </View>
  );
}

function avatarPropsEqual(left: AvatarProps, right: AvatarProps): boolean {
  return (
    left.size === right.size &&
    left.id === right.id &&
    left.round === right.round &&
    left.person === right.person &&
    left.label === right.label &&
    left.shape === right.shape &&
    left.color === right.color &&
    left.material === right.material &&
    left.style === right.style &&
    left.gender === right.gender &&
    left.photo === right.photo &&
    left.mood === right.mood &&
    left.alive === right.alive
  );
}

/**
 * Draws the roster / chat / mention avatar.
 * Why: one shared Dot bakery backs every small avatar (lists, bubbles, badges);
 * live WebGL is only for large hero sizes so scrolling stays fast.
 */
export const Avatar = memo(AvatarInner, avatarPropsEqual);
