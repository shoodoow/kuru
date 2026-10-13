import { useEffect, useMemo, useState } from "react";
import { Alert, AppState, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PluginCard, PluginList } from "../api";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { CircleButton } from "../ui/CircleButton";
import { PrimaryButton } from "../ui/PrimaryButton";
import { pressableStyle } from "../ui/pressableStyles";
import { FormScroll } from "../ui/FormScroll";
import { Sheet } from "../ui/Sheet";
import { IconClose, IconPlus, IconSearch } from "../ui/icons";

/**
 * Browses featured plugins and this account's own connectors.
 * Input: the catalog, and add, remove, and custom handlers.
 * Output: the plugins page. Another account's connectors are not in the list.
 */
export function PluginsPage({
  plugins,
  onCustom,
  onAdd,
  onRemove,
  onRefresh,
  scrollStyle,
}: {
  plugins: PluginList | null;
  onCustom: () => void;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  onRefresh: () => void;
  scrollStyle: ViewStyle;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PluginCard | null>(null);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") onRefresh();
    });
    return () => sub.remove();
  }, [onRefresh]);
  const rows = plugins?.plugins ?? [];
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? rows.filter((row) => `${row.name} ${row.description}`.toLowerCase().includes(needle)) : rows;
  }, [query, rows]);
  // What the person already has comes first, with its state; the rest is what they can add.
  const installed = visible.filter((row) => row.installed);
  const available = visible.filter((row) => !row.installed);
  const sections = [...new Set(available.map((row) => row.section))];
  const row = (live: PluginCard) => (
    <Pressable key={live.id} accessibilityRole="button" onPress={() => setSelected(live)} style={({ pressed }) => pressableStyle(styles.row, { pressed })}>
      <PluginGlyph mark={live.mark} name={live.name} />
      <View style={styles.body}>
        <Text style={styles.name}>{live.name}</Text>
        {live.installed ? (
          <Text style={live.lastError || !live.configured ? styles.error : styles.status} numberOfLines={2}>
            {pluginStatus(live)}
          </Text>
        ) : (
          <Text style={styles.description} numberOfLines={2}>
            {live.description}
          </Text>
        )}
      </View>
      {live.installed ? (
        <Text style={styles.chevron}>›</Text>
      ) : (
        <View style={styles.add}>
          <Text style={styles.addText}>Add</Text>
        </View>
      )}
    </Pressable>
  );
  return (
    <FormScroll style={scrollStyle} contentInsetAdjustmentBehavior="automatic" nestedScrollEnabled contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <View style={styles.search}>
          <IconSearch />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search plugins"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.searchInput}
          />
        </View>
        <CircleButton label="Connect an MCP server" onPress={onCustom}>
          <IconPlus />
        </CircleButton>
      </View>
      {installed.length > 0 ? (
        <View style={styles.sectionBlock}>
          <Text style={styles.section}>Installed · {installed.length}</Text>
          {installed.map(row)}
        </View>
      ) : null}
      {sections.map((section) => (
        <View key={section} style={styles.sectionBlock}>
          <Text style={styles.section}>{installed.length > 0 && section === "Featured" ? "Add more" : section}</Text>
          {available.filter((item) => item.section === section).map(row)}
        </View>
      ))}
      {visible.length === 0 && query.trim() ? <Text style={styles.empty}>No plugin matches "{query.trim()}".</Text> : null}
      <View style={styles.sectionBlock}>
        <Text style={styles.section}>Your own</Text>
        <Pressable accessibilityRole="button" onPress={onCustom} style={({ pressed }) => pressableStyle(styles.row, { pressed })}>
          <View style={[styles.mark, styles.ownMark]}>
            <IconPlus />
          </View>
          <View style={styles.body}>
            <Text style={styles.name}>Connect an MCP server</Text>
            <Text style={styles.description}>Add any tool server by its address.</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      </View>
      <PluginDetail
        plugin={selected ? rows.find((row) => row.id === selected.id) ?? selected : null}
        onClose={() => setSelected(null)}
        onAdd={(id) => {
          onAdd(id);
        }}
        onRemove={(id) => {
          onRemove(id);
          setSelected(null);
        }}
      />
    </FormScroll>
  );
}

/**
 * Adds a public MCP URL for this account only.
 * Input: save and sign-in handlers.
 * Output: the custom plugin form.
 */
export function CustomPluginPage({
  onSave,
  onSignIn,
  scrollStyle,
}: {
  onSave: (name: string, url: string, secret: string) => void | Promise<unknown>;
  onSignIn: (name: string, url: string) => void;
  scrollStyle: ViewStyle;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const ready = name.trim().length > 0 && url.trim().length > 0;
  return (
    <FormScroll style={scrollStyle} contentInsetAdjustmentBehavior="automatic" nestedScrollEnabled contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <Text style={styles.description}>Paste a public HTTPS MCP URL. The token stays on this account's computer.</Text>
      <TextInput value={name} onChangeText={setName} placeholder="Name" placeholderTextColor={colors.muted} autoCapitalize="none" style={styles.input} />
      <TextInput value={url} onChangeText={setUrl} placeholder="https://example.com/mcp" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} style={styles.input} />
      <TextInput value={secret} onChangeText={setSecret} placeholder="Bearer token, if the server uses one" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} secureTextEntry style={styles.input} />
      <PrimaryButton label="Add" disabled={!ready} onPress={() => onSave(name, url, secret)} />
      <PrimaryButton label="Sign in" variant="secondary" disabled={!ready} onPress={() => onSignIn(name, url)} />
    </FormScroll>
  );
}

/**
 * Plugin detail, in the system bottom sheet on both platforms.
 * Input: the selected plugin. Output: description, bundled skills, and Add.
 */
function PluginDetail({
  plugin,
  onClose,
  onAdd,
  onRemove,
}: {
  plugin: PluginCard | null;
  onClose: () => void;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const skills = plugin?.skills ?? [];
  const skillLabel = skills.length === 1 ? "1 skill" : `${skills.length} skills`;
  const insets = useSafeAreaInsets();
  return (
    <Sheet open={plugin !== null} onClose={onClose}>
      {plugin ? (
        <View style={[styles.detail, { paddingBottom: Math.max(28, insets.bottom + 12) }]}>
          <CircleButton label="Close" onPress={onClose}>
            <IconClose />
          </CircleButton>
          <ScrollView style={styles.detailScrollView} contentContainerStyle={styles.detailScroll} showsVerticalScrollIndicator={false}>
            <View style={styles.detailTitle}>
              <PluginGlyph mark={plugin.mark} name={plugin.name} large />
              <Text style={styles.detailName}>{plugin.name}</Text>
            </View>
            <Text style={styles.detailBody}>{plugin.description}</Text>
            {plugin.installed ? (
              <View style={styles.includeCard}>
                <Text style={[styles.includeSummary, plugin.lastError || !plugin.configured ? styles.error : styles.status]}>{pluginStatus(plugin)}</Text>
              </View>
            ) : null}
            <Text style={styles.section}>Includes</Text>
            <View style={styles.includeCard}>
              <Text style={styles.includeSummary}>1 connector{skills.length ? ` · ${skillLabel}` : ""}</Text>
              {skills.map((skill) => (
                <View key={skill.name} style={styles.skillRow}>
                  <Text style={styles.skillName}>{skill.name}</Text>
                  <Text style={styles.description} numberOfLines={2}>
                    {skill.description}
                  </Text>
                </View>
              ))}
            </View>
          </ScrollView>
          {plugin.installed ? (
            <View style={styles.actions}>
              {plugin.lastError || !plugin.configured ? <PrimaryButton label="Connect again" onPress={() => onAdd(plugin.id)} /> : null}
              <PrimaryButton label="Remove" variant="danger" onPress={() => confirmRemove(plugin, onRemove)} />
            </View>
          ) : (
            <PrimaryButton label={`Add ${plugin.name}`} onPress={() => onAdd(plugin.id)} />
          )}
        </View>
      ) : null}
    </Sheet>
  );
}

/** One line saying how an installed plugin is doing. */
function pluginStatus(plugin: PluginCard): string {
  if (plugin.lastError) return plugin.lastError;
  if (!plugin.configured) return "Needs to be connected again";
  return "Connected";
}

/** Removing a plugin takes it from every agent, so it asks first. */
function confirmRemove(plugin: PluginCard, onRemove: (id: string) => void): void {
  Alert.alert(`Remove ${plugin.name}?`, "Your agents can no longer use it. You can add it again later.", [
    { text: "Cancel", style: "cancel" },
    { text: "Remove", style: "destructive", onPress: () => onRemove(plugin.id) },
  ]);
}

/** Shows the plugin icon, or the letter on its color when the icon is missing. */
function PluginGlyph({ mark, name, large }: { mark?: PluginCard["mark"]; name: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const size = large ? styles.iconLarge : styles.icon;
  const letter = mark?.letter || name.trim().slice(0, 1).toUpperCase() || "?";
  const color = mark?.color || colors.control;
  if (mark?.icon && !failed) {
    return <Image source={{ uri: mark.icon }} style={size} onError={() => setFailed(true)} />;
  }
  return (
    <View style={[large ? styles.markLarge : styles.mark, { backgroundColor: color }]}>
      <Text style={styles.markText}>{letter}</Text>
    </View>
  );
}

export function pluginSlug(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(slug)) throw new Error("Use a name that starts with a letter.");
  return slug;
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  scroll: { padding: 14, paddingBottom: 28, gap: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  search: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.card, borderRadius: 18, paddingHorizontal: 12, height: 44 },
  searchInput: { flex: 1, color: colors.text, fontSize: 16 },
  sectionBlock: { gap: 8 },
  section: { color: colors.muted, fontSize: 13, marginLeft: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.card, borderRadius: 16, padding: 12 },
  icon: { width: 40, height: 40, borderRadius: 12 },
  iconLarge: { width: 64, height: 64, borderRadius: 16 },
  mark: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  markLarge: { width: 64, height: 64, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  detail: { flex: 1, backgroundColor: colors.sheet, padding: 16, paddingBottom: 28 },
  detailScrollView: { flex: 1 },
  detailScroll: { gap: 14, paddingBottom: 24 },
  detailTitle: { flexDirection: "row", alignItems: "center", gap: 14, marginTop: 12 },
  detailName: { color: colors.text, fontSize: 28, fontWeight: "700", flex: 1 },
  detailBody: { color: colors.text, fontSize: 16, lineHeight: 22 },
  includeCard: { backgroundColor: colors.card, borderRadius: 16, overflow: "hidden" },
  includeSummary: { color: colors.text, fontSize: 15, paddingHorizontal: 14, paddingVertical: 14 },
  skillRow: { gap: 4, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  skillName: { color: colors.text, fontSize: 15, fontWeight: "600" },
  markText: { color: "#fff", fontWeight: "700" },
  body: { flex: 1, gap: 2 },
  name: { color: colors.text, fontSize: 16, fontWeight: "600" },
  description: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 13, lineHeight: 18 },
  status: { color: colors.online, fontSize: 13, lineHeight: 18 },
  chevron: { color: colors.muted, fontSize: 22, paddingHorizontal: 4 },
  empty: { color: colors.muted, fontSize: 14, textAlign: "center", paddingVertical: 16 },
  ownMark: { backgroundColor: colors.control },
  actions: { gap: 10 },
  add: { backgroundColor: colors.control, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  addText: { color: colors.text, fontSize: 14, fontWeight: "600" },
  input: { backgroundColor: colors.card, color: colors.text, borderRadius: 14, height: 48, paddingHorizontal: 14, fontSize: 16 },
  primary: { backgroundColor: colors.text, borderRadius: 22, height: 48, alignItems: "center", justifyContent: "center" },
  primaryText: { color: colors.bg, fontSize: 16, fontWeight: "600" },
  secondary: { backgroundColor: colors.card, borderRadius: 22, height: 48, alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.4 },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
