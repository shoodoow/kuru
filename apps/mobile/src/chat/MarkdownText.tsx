import { useState, type ReactNode } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { makeMutable } from "react-native-reanimated";
import { darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { LinkPreview } from "./LinkPreview";
import { extractUrls, parseMarkdownBlocks, trimUrl } from "./markdown";
import { copyText } from "./SelectTextSheet";

/** A small text button that copies and says so for a moment. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Pressable
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Copy code"
      onPress={() => {
        void copyText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <Text style={styles.codeCopy}>{copied ? "Copied" : "Copy"}</Text>
    </Pressable>
  );
}

// True while a finger is down on something inside a bubble that handles its own
// drags: a table that scrolls sideways, a video being scrubbed. The bubble's
// swipe-to-reply reads it on the UI thread and stands down.
export const innerTouching = makeMutable(false);

/**
 * Wide tables scroll sideways inside the bubble.
 * Why the inner view claims the touch: the bubble around a table is a
 * Pressable. When a Pressable holds the touch, iOS turns off every scroll
 * view inside it, so the table sat still and its last columns stayed cut off.
 * With the claim, the touch belongs to a view inside the scroller instead,
 * and the scroller is free to pan. (Holding a table no longer opens the
 * message menu; holding the text around it still does.)
 * Why the maxWidth: it keeps the frame inside the bubble's widest (85% of the
 * thread row, see ChatScreen `column`) whatever the content measures.
 */
export function HorizontalTableScroll({ children }: { children: ReactNode }) {
  const { width } = useWindowDimensions();
  const release = (): void => {
    innerTouching.value = false;
  };
  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      directionalLockEnabled
      showsHorizontalScrollIndicator
      keyboardShouldPersistTaps="handled"
      style={[styles.horizontalTableScroll, { maxWidth: Math.round((width - 24) * 0.85) }]}
      contentContainerStyle={styles.horizontalTableContent}
      onTouchStart={() => {
        innerTouching.value = true;
      }}
      onTouchEnd={release}
      onTouchCancel={release}
      onScrollEndDrag={release}
    >
      <View onStartShouldSetResponder={() => true} onResponderTerminationRequest={() => true}>
        {children}
      </View>
    </ScrollView>
  );
}

export const MONO = process.env.EXPO_OS === "ios" ? "Menlo" : "monospace";

const MD_TABLE_COL = { minWidth: 128, maxWidth: 240, flexShrink: 0 as const };

/**
 * Renders chat markdown: headings, bullets, bold/italic, inline code, links,
 * fenced code, and tables, plus a preview card per link.
 * Why: agents write markdown everywhere (messages, team briefs, .md files);
 * showing the raw marks reads as broken.
 * Input: markdown text; `links={false}` leaves the preview cards out.
 * Output: the rendered text.
 */
export function MarkdownText({ text, links = true }: { text: string; links?: boolean }) {
  const blocks = parseMarkdownBlocks(text);
  const urls = links ? extractUrls(text) : [];
  if (blocks.length === 1 && blocks[0]?.kind === "text" && urls.length === 0) {
    return <Text style={styles.body}>{renderLines(blocks[0].text)}</Text>;
  }
  return (
    <View style={styles.richStack}>
      {blocks.map((block, index) =>
        block.kind === "table" ? (
          <HorizontalTableScroll key={index}>
            <View style={styles.mdTableHead}>
              {block.columns.map((column, columnIndex) => (
                <Text key={columnIndex} style={[styles.mdTableHeader, MD_TABLE_COL]}>
                  {renderInlineMarkdown(column, `h-${index}-${columnIndex}`)}
                </Text>
              ))}
            </View>
            {block.rows.map((row, rowIndex) => (
              <View key={rowIndex} style={styles.mdTableRow}>
                {block.columns.map((_, columnIndex) => (
                  <Text key={columnIndex} style={[styles.mdTableCell, MD_TABLE_COL]}>
                    {renderInlineMarkdown(row[columnIndex] ?? "", `c-${index}-${rowIndex}-${columnIndex}`)}
                  </Text>
                ))}
              </View>
            ))}
          </HorizontalTableScroll>
        ) : block.kind === "code" ? (
          <View key={index} style={styles.codeWrap}>
            <View style={styles.codeHead}>
              <Text style={styles.codeLang}>{block.language || "code"}</Text>
              <CopyButton text={block.code} />
            </View>
            <Text style={styles.code}>{block.code}</Text>
          </View>
        ) : (
          <Text key={index} style={styles.body}>
            {renderLines(block.text, `p-${index}`)}
          </Text>
        ),
      )}
      {urls.map((url) => (
        <LinkPreview key={url} url={url} />
      ))}
    </View>
  );
}

/** Styles one paragraph line by line: headings, rules, and bullets. */
function renderLines(text: string, keyPrefix = "t"): ReactNode[] {
  const lines = text.split("\n");
  return lines.map((line, number) => {
    const key = `${keyPrefix}-l${number}`;
    const tail = number < lines.length - 1 ? "\n" : "";
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      return (
        <Text key={key} style={(heading[1] ?? "").length <= 2 ? styles.mdH1 : styles.mdH2}>
          {renderInlineMarkdown((heading[2] ?? "").replace(/\s+#+\s*$/, ""), key)}
          {tail}
        </Text>
      );
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      return (
        <Text key={key} style={styles.mdRule}>
          {"────────"}
          {tail}
        </Text>
      );
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      return (
        <Text key={key}>
          {bullet[1]}
          {"•  "}
          {renderInlineMarkdown(bullet[2] ?? "", key)}
          {tail}
        </Text>
      );
    }
    return (
      <Text key={key}>
        {renderInlineMarkdown(line, key)}
        {tail}
      </Text>
    );
  });
}

function renderInlineMarkdown(text: string, keyPrefix = "t"): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(\*\*(?<bold>[^*]+)\*\*|`(?<code>[^`]+)`|\[(?<label>[^\]]+)\]\((?<href>https?:\/\/[^)\s]+)\)|(?<bare>https?:\/\/\S+)|\*(?<italic>[^*\s][^*]*)\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(<Text key={`${keyPrefix}-${i++}`}>{text.slice(last, match.index)}</Text>);
    }
    const found = match.groups ?? {};
    if (found.bold !== undefined) {
      nodes.push(
        <Text key={`${keyPrefix}-${i++}`} style={styles.mdBold}>
          {found.bold}
        </Text>,
      );
    } else if (found.code !== undefined) {
      nodes.push(
        <Text key={`${keyPrefix}-${i++}`} style={styles.mdCode}>
          {found.code}
        </Text>,
      );
    } else if (found.label !== undefined && found.href !== undefined) {
      const href = found.href;
      nodes.push(
        <Text key={`${keyPrefix}-${i++}`} style={styles.link} onPress={() => void Linking.openURL(href)}>
          {found.label}
        </Text>,
      );
    } else if (found.bare !== undefined) {
      // A bare URL swallows the full stop or bracket after it; hand that back.
      const href = trimUrl(found.bare);
      nodes.push(
        <Text key={`${keyPrefix}-${i++}`} style={styles.link} onPress={() => void Linking.openURL(href)}>
          {href}
        </Text>,
      );
      if (href.length < found.bare.length) {
        nodes.push(<Text key={`${keyPrefix}-${i++}`}>{found.bare.slice(href.length)}</Text>);
      }
    } else if (found.italic !== undefined) {
      nodes.push(
        <Text key={`${keyPrefix}-${i++}`} style={styles.mdItalic}>
          {found.italic}
        </Text>,
      );
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    nodes.push(<Text key={`${keyPrefix}-${i++}`}>{text.slice(last)}</Text>);
  }
  return nodes.length > 0 ? nodes : [<Text key={`${keyPrefix}-0`}>{text}</Text>];
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    body: { color: colors.text, fontSize: 16, lineHeight: 24 },
    mdBold: { fontWeight: "700", color: colors.text },
    mdItalic: { fontStyle: "italic" },
    mdH1: { fontSize: 19, fontWeight: "700", color: colors.text },
    mdH2: { fontSize: 17, fontWeight: "700", color: colors.text },
    mdRule: { color: colors.line },
    richStack: { gap: 8 },
    horizontalTableScroll: { marginHorizontal: -14, flexGrow: 0 },
    horizontalTableContent: { paddingHorizontal: 14, flexGrow: 1 },
    mdTableHead: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
    mdTableHeader: { color: colors.text, fontSize: 13, fontWeight: "700", paddingVertical: 6, paddingRight: 12 },
    mdTableRow: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
    mdTableCell: { color: colors.text, fontSize: 13, lineHeight: 18, paddingVertical: 6, paddingRight: 12 },
    mdCode: { fontFamily: MONO, fontSize: 14, color: colors.text, backgroundColor: colors.control },
    link: { color: colors.link },
    codeWrap: { backgroundColor: colors.control, borderRadius: 10, padding: 10, gap: 4 },
    codeHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16 },
    codeLang: { color: colors.muted, fontSize: 12 },
    codeCopy: { color: colors.link, fontSize: 12, fontWeight: "600" },
    code: { color: colors.text, fontFamily: MONO, fontSize: 13 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
