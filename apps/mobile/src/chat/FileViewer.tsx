import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { PillButton } from "../ui/PrimaryButton";
import { presentOverlay } from "../ui/overlay";
import { Sheet } from "../ui/Sheet";
import { MONO, MarkdownText } from "./MarkdownText";
import { openFileBlock, readFileText, saveFileBlock, shareFileBlock, type FetchBlob, type FileBlock } from "./media";

const TEXT_NAME =
  /\.(md|markdown|txt|json|jsonl|csv|tsv|log|ya?ml|toml|xml|html?|css|jsx?|tsx?|py|sh|sql|env|ini|conf)$/i;
// Past this the sheet shows the start only; Save and Open in still carry it all.
const SHOWN_CHARS = 200_000;

/** True for files the app can show as text itself instead of sending away. */
export function isTextFile(block: FileBlock): boolean {
  const mime = (block.mime ?? "").toLowerCase();
  return TEXT_NAME.test(block.name) || mime.startsWith("text/") || /^application\/(json|xml|x-yaml|yaml)/.test(mime);
}

/**
 * One file row in a bubble. Text files open in the in-app viewer; anything
 * else goes to the system preview/share sheet as before.
 */
export function FileCard({ block, fetchBlob }: { block: FileBlock; fetchBlob?: FetchBlob }) {
  const readable = isTextFile(block);
  return (
    <Pressable
      style={styles.fileWrap}
      onPress={() => {
        // Drawn from the top of the app, not from inside this bubble: see presentOverlay.
        if (readable) presentOverlay((close) => <FileViewer block={block} fetchBlob={fetchBlob} onClose={close} />);
        else void openFileBlock(block, fetchBlob);
      }}
    >
      <Text style={styles.fileName}>{block.name}</Text>
      <Text style={styles.fileHint}>{readable ? "Tap to view" : "Tap to open"}</Text>
    </Pressable>
  );
}

/**
 * Shows a text file the agent sent, with Save and Open in.
 * Why: agents hand over reports as .md and data as .json. The share sheet
 * alone made the person leave the app just to read one. Markdown renders,
 * JSON is indented, everything else shows as plain monospace text.
 * Input: the file block + blob fetcher. Output: the sheet.
 */
function FileViewer({ block, fetchBlob, onClose }: { block: FileBlock; fetchBlob?: FetchBlob; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"save" | "share" | null>(null);
  // The sheet slides shut first; the card forgets the viewer once it is gone.
  const [open, setOpen] = useState(true);
  const close = (): void => {
    setOpen(false);
    setTimeout(onClose, 320);
  };
  useEffect(() => {
    let live = true;
    void readFileText(block, fetchBlob)
      .then((loaded) => {
        if (live) setText(loaded);
      })
      .catch((error: unknown) => {
        if (live) {
          setText("");
          setNote(error instanceof Error ? error.message : "The file did not load.");
        }
      });
    return () => {
      live = false;
    };
  }, [block, fetchBlob]);

  const markdown = /\.(md|markdown)$/i.test(block.name);
  const shown = text === null ? "" : pretty(block.name, text).slice(0, SHOWN_CHARS);

  function run(kind: "save" | "share"): void {
    if (busy) return;
    setBusy(kind);
    setNote("");
    const work = kind === "save" ? saveFileBlock(block, fetchBlob).then((saved) => (saved ? "Saved." : "")) : shareFileBlock(block, fetchBlob).then(() => "");
    void work
      .then(setNote)
      .catch(() => setNote(kind === "save" ? "Could not save there. Try Open in." : "Could not open the share sheet."))
      .finally(() => setBusy(null));
  }

  return (
    <Sheet open={open} onClose={close}>
      <View style={styles.sheet}>
        <View style={styles.bar}>
          <Pressable onPress={close} hitSlop={8} accessibilityRole="button">
            <Text style={styles.done}>Done</Text>
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>
            {block.name}
          </Text>
          <View style={styles.barSpacer} />
        </View>
        {text === null ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.muted} />
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.body}>
            {markdown ? (
              <MarkdownText text={shown} links={false} />
            ) : (
              <Text selectable style={styles.plain}>
                {shown}
              </Text>
            )}
            {text.length > SHOWN_CHARS ? <Text style={styles.note}>Showing the first part. Save it to read the rest.</Text> : null}
          </ScrollView>
        )}
        <View style={[styles.actions, { paddingBottom: Math.max(12, insets.bottom) }]}>
          {note ? <Text style={styles.note}>{note}</Text> : null}
          <View style={styles.buttons}>
            <View style={styles.button}>
              <PillButton label="Save" tone="muted" busy={busy === "save"} disabled={busy !== null} onPress={() => run("save")} />
            </View>
            <View style={styles.button}>
              <PillButton label="Open in…" busy={busy === "share"} disabled={busy !== null} onPress={() => run("share")} />
            </View>
          </View>
        </View>
      </View>
    </Sheet>
  );
}

/** Indents JSON so it reads; anything that does not parse shows as it came. */
function pretty(name: string, text: string): string {
  if (!/\.json$/i.test(name)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    fileWrap: { backgroundColor: colors.control, borderRadius: 10, padding: 12, gap: 2 },
    fileName: { color: colors.text, fontWeight: "600" },
    fileHint: { color: colors.muted, fontSize: 12 },
    sheet: { flex: 1, backgroundColor: colors.bg },
    bar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    done: { color: colors.link, fontSize: 17, width: 52 },
    barSpacer: { width: 52 },
    title: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "600", textAlign: "center" },
    loading: { flex: 1, alignItems: "center", justifyContent: "center" },
    body: { paddingHorizontal: 16, paddingVertical: 16, gap: 12 },
    plain: { color: colors.text, fontFamily: MONO, fontSize: 13, lineHeight: 19 },
    note: { color: colors.muted, fontSize: 13, textAlign: "center" },
    actions: {
      paddingHorizontal: 16,
      paddingTop: 10,
      gap: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
    },
    buttons: { flexDirection: "row", gap: 10 },
    button: { flex: 1 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
