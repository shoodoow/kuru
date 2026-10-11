import { View } from "react-native";
import type { MarkShape } from "@kuru/shared";

const INK = "#2B2B2E";

/**
 * Distinct 2D silhouette for each Dot form.
 * Why: the shape picker must show different outlines immediately; 3D thumbs can fill in later.
 */
export function ShapeGlyph({ shape, color, size }: { shape: MarkShape; color: string; size: number }) {
  const eye = Math.max(3, size * 0.14);
  const gap = size * 0.16;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {body(shape, color, size)}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          flexDirection: "row",
          alignItems: "center",
          marginTop: eyeDy(shape, size),
        }}
      >
        <View style={eyeStyle(eye, shape)} />
        <View style={[eyeStyle(eye, shape), { marginLeft: gap }]} />
      </View>
      {shape === "cat" ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            marginTop: size * 0.18,
            width: size * 0.1,
            height: size * 0.08,
            borderRadius: size,
            backgroundColor: "#FF8FB8",
          }}
        />
      ) : null}
    </View>
  );
}

function eyeDy(shape: MarkShape, size: number): number {
  if (shape === "triangle") return size * 0.1;
  if (shape === "heart" || shape === "sprout" || shape === "butterfly") return size * 0.06;
  if (shape === "cat") return size * 0.04;
  return 0;
}

function eyeStyle(size: number, shape: MarkShape) {
  if (shape === "robot") {
    return { width: size * 1.15, height: size * 0.85, borderRadius: size * 0.2, backgroundColor: INK };
  }
  return { width: size, height: size * 1.12, borderRadius: size, backgroundColor: INK };
}

function body(shape: MarkShape, color: string, size: number) {
  switch (shape) {
    case "round":
      return <View style={{ width: size * 0.92, height: size * 0.86, borderRadius: size, backgroundColor: color }} />;
    case "pill":
      return <View style={{ width: size * 1.05, height: size * 0.58, borderRadius: size, backgroundColor: color }} />;
    case "ears":
      return (
        <View style={{ width: size, height: size * 0.95, alignItems: "center" }}>
          <View style={{ flexDirection: "row", width: size * 0.78, justifyContent: "space-between", marginBottom: -size * 0.1 }}>
            <View style={{ width: size * 0.26, height: size * 0.26, borderRadius: size, backgroundColor: color }} />
            <View style={{ width: size * 0.26, height: size * 0.26, borderRadius: size, backgroundColor: color }} />
          </View>
          <View style={{ width: size * 0.88, height: size * 0.74, borderRadius: size * 0.4, backgroundColor: color }} />
        </View>
      );
    case "triangle":
      return (
        <View style={{ width: size, height: size * 0.9, alignItems: "center", justifyContent: "flex-end" }}>
          <View
            style={{
              width: 0,
              height: 0,
              borderLeftWidth: size * 0.42,
              borderRightWidth: size * 0.42,
              borderBottomWidth: size * 0.72,
              borderLeftColor: "transparent",
              borderRightColor: "transparent",
              borderBottomColor: color,
            }}
          />
          <View
            style={{
              position: "absolute",
              bottom: size * 0.06,
              width: size * 0.64,
              height: size * 0.3,
              borderRadius: size,
              backgroundColor: color,
            }}
          />
        </View>
      );
    case "cloud":
      return (
        <View style={{ width: size, height: size * 0.82 }}>
          <View style={{ position: "absolute", left: 0, bottom: 0, width: size * 0.44, height: size * 0.44, borderRadius: size, backgroundColor: color }} />
          <View style={{ position: "absolute", left: size * 0.22, top: 0, width: size * 0.56, height: size * 0.56, borderRadius: size, backgroundColor: color }} />
          <View style={{ position: "absolute", right: 0, bottom: 0, width: size * 0.4, height: size * 0.4, borderRadius: size, backgroundColor: color }} />
        </View>
      );
    case "heart":
      return (
        <View style={{ width: size * 0.9, height: size * 0.9, alignItems: "center" }}>
          <View style={{ flexDirection: "row", justifyContent: "center" }}>
            <View style={{ width: size * 0.42, height: size * 0.42, borderRadius: size, marginRight: -size * 0.05, backgroundColor: color }} />
            <View style={{ width: size * 0.42, height: size * 0.42, borderRadius: size, marginLeft: -size * 0.05, backgroundColor: color }} />
          </View>
          <View
            style={{
              marginTop: -size * 0.18,
              width: 0,
              height: 0,
              borderLeftWidth: size * 0.36,
              borderRightWidth: size * 0.36,
              borderTopWidth: size * 0.44,
              borderLeftColor: "transparent",
              borderRightColor: "transparent",
              borderTopColor: color,
            }}
          />
        </View>
      );
    case "butterfly":
      return (
        <View style={{ width: size, height: size * 0.9, alignItems: "center", justifyContent: "center" }}>
          <View style={{ position: "absolute", left: 0, top: size * 0.08, width: size * 0.4, height: size * 0.46, borderRadius: size * 0.24, backgroundColor: color }} />
          <View style={{ position: "absolute", right: 0, top: size * 0.08, width: size * 0.4, height: size * 0.46, borderRadius: size * 0.24, backgroundColor: color }} />
          <View style={{ position: "absolute", left: size * 0.06, bottom: size * 0.04, width: size * 0.32, height: size * 0.34, borderRadius: size * 0.2, backgroundColor: color }} />
          <View style={{ position: "absolute", right: size * 0.06, bottom: size * 0.04, width: size * 0.32, height: size * 0.34, borderRadius: size * 0.2, backgroundColor: color }} />
          <View style={{ width: size * 0.28, height: size * 0.48, borderRadius: size, backgroundColor: color }} />
        </View>
      );
    case "sprout":
      return (
        <View style={{ width: size * 0.9, height: size, alignItems: "center" }}>
          <View style={{ flexDirection: "row", marginBottom: -size * 0.06 }}>
            <View style={{ width: size * 0.28, height: size * 0.24, borderRadius: size, marginRight: -size * 0.03, backgroundColor: color, transform: [{ rotate: "-28deg" }] }} />
            <View style={{ width: size * 0.28, height: size * 0.24, borderRadius: size, marginLeft: -size * 0.03, backgroundColor: color, transform: [{ rotate: "28deg" }] }} />
          </View>
          <View style={{ width: size * 0.78, height: size * 0.68, borderRadius: size * 0.36, backgroundColor: color }} />
        </View>
      );
    case "scallop":
      return (
        <View style={{ width: size, height: size * 0.88 }}>
          <View style={{ position: "absolute", left: size * 0.06, bottom: 0, width: size * 0.44, height: size * 0.48, borderRadius: size, backgroundColor: color }} />
          <View style={{ position: "absolute", right: size * 0.06, bottom: 0, width: size * 0.44, height: size * 0.48, borderRadius: size, backgroundColor: color }} />
          <View style={{ position: "absolute", left: size * 0.14, top: 0, width: size * 0.72, height: size * 0.64, borderRadius: size * 0.36, backgroundColor: color }} />
        </View>
      );
    case "hexagon":
      return (
        <View style={{ alignItems: "center" }}>
          <View
            style={{
              width: size * 0.46,
              borderLeftWidth: size * 0.21,
              borderRightWidth: size * 0.21,
              borderBottomWidth: size * 0.18,
              borderLeftColor: "transparent",
              borderRightColor: "transparent",
              borderBottomColor: color,
            }}
          />
          <View style={{ width: size * 0.88, height: size * 0.42, backgroundColor: color }} />
          <View
            style={{
              width: size * 0.46,
              borderLeftWidth: size * 0.21,
              borderRightWidth: size * 0.21,
              borderTopWidth: size * 0.18,
              borderLeftColor: "transparent",
              borderRightColor: "transparent",
              borderTopColor: color,
            }}
          />
        </View>
      );
    case "diamond":
      return (
        <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
          <View
            style={{
              width: size * 0.68,
              height: size * 0.68,
              borderRadius: size * 0.18,
              backgroundColor: color,
              transform: [{ rotate: "45deg" }],
            }}
          />
        </View>
      );
    case "cat":
      return (
        <View style={{ width: size, height: size, alignItems: "center" }}>
          <View style={{ flexDirection: "row", width: size * 0.84, justifyContent: "space-between", marginBottom: -size * 0.16, zIndex: 1 }}>
            <View
              style={{
                width: 0,
                height: 0,
                borderLeftWidth: size * 0.14,
                borderRightWidth: size * 0.14,
                borderBottomWidth: size * 0.28,
                borderLeftColor: "transparent",
                borderRightColor: "transparent",
                borderBottomColor: color,
                transform: [{ rotate: "-8deg" }],
              }}
            />
            <View
              style={{
                width: 0,
                height: 0,
                borderLeftWidth: size * 0.14,
                borderRightWidth: size * 0.14,
                borderBottomWidth: size * 0.28,
                borderLeftColor: "transparent",
                borderRightColor: "transparent",
                borderBottomColor: color,
                transform: [{ rotate: "8deg" }],
              }}
            />
          </View>
          <View style={{ width: size * 0.88, height: size * 0.76, borderRadius: size * 0.4, backgroundColor: color }} />
        </View>
      );
    case "robot":
      return (
        <View style={{ width: size * 0.9, height: size, alignItems: "center" }}>
          <View style={{ width: size * 0.07, height: size * 0.12, borderRadius: 2, marginBottom: -1, backgroundColor: color }} />
          <View style={{ width: size * 0.12, height: size * 0.12, borderRadius: size, marginBottom: -size * 0.03, backgroundColor: color }} />
          <View style={{ width: size * 0.8, height: size * 0.62, borderRadius: size * 0.16, backgroundColor: color }} />
        </View>
      );
  }
}
