import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/tokens";

/** True when a drag carries files, not text or a link dragged out of the page. */
function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Lets a person drag files onto the open chat, or paste a picture into it,
 * in a browser or the desktop app. Both attach the files like the + menu does.
 * Why the whole window and not the composer: on a computer people drop a file
 * anywhere over the chat, and a missed drop would make the browser open the
 * file in place of the app.
 * Pasting text is left alone; only a paste that holds files is taken.
 * Input: what to do with the files. Output: a hint over the chat while a drag is over it.
 */
export function FileDrop({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [over, setOver] = useState(false);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  useEffect(() => {
    if (process.env.EXPO_OS !== "web" || typeof window === "undefined") return;
    // dragenter and dragleave fire for every element crossed; counting them tells when the drag left the window.
    let depth = 0;
    const enter = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setOver(true);
    };
    const overWindow = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const drop = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setOver(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) onFilesRef.current(files);
    };
    const paste = (event: ClipboardEvent): void => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      onFilesRef.current(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", overWindow);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", overWindow);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("paste", paste);
    };
  }, []);

  if (!over) return null;
  return (
    <View style={[StyleSheet.absoluteFill, styles.veil]} pointerEvents="none">
      <View style={[styles.box, { borderColor: colors.muted, backgroundColor: colors.sheet }]}>
        <Text style={[styles.title, { color: colors.text }]}>Drop to attach</Text>
        <Text style={[styles.hint, { color: colors.muted }]}>Pictures up to 5MB, other files up to 2MB</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  veil: { zIndex: 50, padding: 16, backgroundColor: "rgba(0,0,0,0.45)" },
  box: {
    flex: 1,
    borderWidth: 2,
    borderStyle: "dashed",
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  title: { fontSize: 20, fontWeight: "600" },
  hint: { fontSize: 14 },
});
