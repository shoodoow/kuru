import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Image } from "expo-image";
import { useNavigation } from "expo-router";
import { HeaderBackButton } from "expo-router/react-navigation";
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import type { MessageBlock, ProviderSetting, RosterAgent, Routine, RoutineRun } from "../api";
import { formatLastRun, formatNextRunRelative, formatRunHistoryWhen, formatSchedule, routineTitle } from "../api";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import Feather from "@expo/vector-icons/Feather";
import { IconCheck, IconChevron, IconClock, IconDoc, IconMore, IconShare } from "../ui/icons";
import { warmMarkThumbs } from "../ui/DotStage";
import { FormScroll } from "../ui/FormScroll";
import { useNavBarPad } from "../ui/nav-bar-pad";
import {
  LivingMark,
  MARK_COLORS,
  MARK_DEFAULT,
  MARK_MATERIALS,
  MARK_SHAPES,
  Mark,
  resolveMarkLook,
  type MarkLook,
} from "../ui/Mark";
import { openFileBlock } from "./blocks";
import { PrimaryButton } from "../ui/PrimaryButton";
import { collectShares, type SharedFile } from "./shares";
import { MediaThumb } from "./media";

type Page = "info" | "instructions" | "provider" | "routine";
type Tab = "info" | "links" | "media" | "files";
type CharacterTab = "shape" | "color" | "material";

const headerHit = { width: 36, height: 36, alignItems: "center" as const, justifyContent: "center" as const };

const CHARACTER_TABS: { id: CharacterTab; label: string }[] = [
  { id: "shape", label: "Shape" },
  { id: "color", label: "Color" },
  { id: "material", label: "Material" },
];

const TABS: { id: Tab; label: string }[] = [
  { id: "info", label: "Info" },
  { id: "links", label: "Links" },
  { id: "media", label: "Media" },
  { id: "files", label: "Files" },
];

/**
 * Shows the bot info page, opened by tapping the agent name in chat.
 * Why: name card, character mark, instructions, routines, and notifications
 * live here; provider/model/flags sit under Advanced.
 * Input: the editable profile draft, providers, routines, and actions.
 * Output: the info page with instructions / provider / routine sub-pages.
 * The mark shape, color, material, and photo save with the profile, so
 * reopening the page shows exactly what was picked.
 */
export function BotInfoScreen({
  profile,
  providers,
  routines,
  onChange,
  onSave,
  onSaveNotify,
  onBack,
  onApprovals,
  onPickAvatar,
  onPauseRoutine,
  onLoadRoutineRuns,
  messages,
  onFetchBlob,
}: {
  profile: RosterAgent;
  providers: ProviderSetting[];
  routines: Routine[];
  onChange: (profile: RosterAgent) => void;
  onSave: () => void | Promise<unknown>;
  onSaveNotify: (profile: RosterAgent) => void;
  onBack: () => void;
  onApprovals: () => void;
  onPickAvatar: () => void;
  onPauseRoutine: (routine: Routine, paused: boolean) => void;
  onLoadRoutineRuns: (routineId: string) => Promise<RoutineRun[]>;
  messages: { conversationId?: string; body: string; blocks?: MessageBlock[] | null }[];
  onFetchBlob?: (conversationId: string, messageId: string, index: number) => Promise<{ url?: string; previewUrl?: string }>;
}) {
  const [page, setPage] = useState<Page>("info");
  const [tab, setTab] = useState<Tab>("info");
  const [mark, setMark] = useState(() => initialMark(profile));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = routines.find((row) => row.id === selectedId) ?? null;
  const navigation = useNavigation();
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useLayoutEffect(() => {
    const title =
      page === "instructions" ? "Instructions" : page === "provider" ? "Provider" : page === "routine" && selected ? routineTitle(selected) : profile.name || "Profile";
    const back = page === "info" ? () => onBackRef.current() : () => setPage("info");
    navigation.setOptions({
      title,
      headerLeft: () => <HeaderBackButton tintColor={colors.text} onPress={back} />,
      headerRight:
        page === "info"
          ? () => (
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Pressable
                  accessibilityLabel="Share bot"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => {
                    void Share.share({ message: `${profile.name} — ${profile.role}` }).catch(() => {});
                  }}
                  style={headerHit}
                >
                  <IconShare />
                </Pressable>
                <Pressable
                  accessibilityLabel="More"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => {
                    Alert.alert(profile.name, undefined, [
                      { text: "Approvals", onPress: onApprovals },
                      { text: "Cancel", style: "cancel" },
                    ]);
                  }}
                  style={headerHit}
                >
                  <IconMore />
                </Pressable>
              </View>
            )
          : () => null,
    });
  }, [navigation, onApprovals, page, profile.name, profile.role, selected?.id]);

  /** Stages one mark pick in the preview and the profile draft (clears photo). */
  function pickMark(next: MarkLook): void {
    setMark(next);
    onChange({
      ...profile,
      markShape: next.shape,
      markColor: next.color,
      markMaterial: next.material,
      markStyle: next.style,
      markGender: next.gender,
      avatarUrl: null,
    });
  }

  /** Restores the default mark and clears the photo. */
  function resetMark(): void {
    setMark(MARK_DEFAULT);
    onChange({
      ...profile,
      markShape: MARK_DEFAULT.shape,
      markColor: MARK_DEFAULT.color,
      markMaterial: MARK_DEFAULT.material,
      markStyle: MARK_DEFAULT.style,
      markGender: MARK_DEFAULT.gender,
      avatarUrl: null,
    });
  }

  if (page === "instructions") {
    return (
      <InstructionsPage
        profile={profile}
        onChange={onChange}
        onSave={onSave}
      />
    );
  }
  if (page === "provider") {
    return (
      <ProviderPage
        profile={profile}
        providers={providers}
        onSelect={(provider) => {
          onChange({ ...profile, provider });
          setPage("info");
        }}
      />
    );
  }
  if (page === "routine" && selected) {
    return (
      <RoutineDetailPage
        routine={selected}
        onPause={(paused) => onPauseRoutine(selected, paused)}
        onLoadRuns={() => onLoadRoutineRuns(selected.id)}
        onBack={() => setPage("info")}
      />
    );
  }
  return (
    <InfoPage
      profile={profile}
      providers={providers}
      routines={routines}
      mark={mark}
      tab={tab}
      onTab={setTab}
      onPickMark={pickMark}
      onResetMark={resetMark}
      onPickAvatar={onPickAvatar}
      onChange={onChange}
      onSave={onSave}
      onSaveNotify={onSaveNotify}
      onInstructions={() => setPage("instructions")}
      onProvider={() => setPage("provider")}
      onRoutine={(routine) => {
        setSelectedId(routine.id);
        setPage("routine");
      }}
      messages={messages}
      onFetchBlob={onFetchBlob}
    />
  );
}

/** Reads the saved mark, falling back to the default for legacy agents. */
function initialMark(profile: RosterAgent): MarkLook {
  return resolveMarkLook(profile);
}

/**
 * Shows the Info tab: mark, name card, tabs, character, instructions,
 * routines, notifications, and advanced model flags.
 */
function InfoPage({
  profile,
  providers,
  routines,
  mark,
  tab,
  onTab,
  onPickMark,
  onResetMark,
  onPickAvatar,
  onChange,
  onSave,
  onSaveNotify,
  onInstructions,
  onProvider,
  onRoutine,
  messages,
  onFetchBlob,
}: {
  profile: RosterAgent;
  providers: ProviderSetting[];
  routines: Routine[];
  mark: MarkLook;
  tab: Tab;
  onTab: (tab: Tab) => void;
  onPickMark: (mark: MarkLook) => void;
  onResetMark: () => void;
  onPickAvatar: () => void;
  onChange: (profile: RosterAgent) => void;
  onSave: () => void | Promise<unknown>;
  onSaveNotify: (profile: RosterAgent) => void;
  onInstructions: () => void;
  onProvider: () => void;
  onRoutine: (routine: Routine) => void;
  messages: { conversationId?: string; body: string; blocks?: MessageBlock[] | null }[];
  onFetchBlob?: (conversationId: string, messageId: string, index: number) => Promise<{ url?: string; previewUrl?: string }>;
}) {
  const [characterTab, setCharacterTab] = useState<CharacterTab>("shape");
  useEffect(() => {
    warmMarkThumbs([mark], { prioritize: true });
  }, [mark.shape, mark.color, mark.material, mark.style, mark.gender]);
  useEffect(() => {
    if (characterTab !== "shape" || profile.avatarUrl) return;
    warmMarkThumbs(
      MARK_SHAPES.map((entry) => ({ ...mark, shape: entry.id })),
      { prioritize: false },
    );
  }, [characterTab, mark.color, mark.material, mark.style, mark.gender, profile.avatarUrl]);
  const configured = providers.filter((row) => row.configured);
  const providerChoices: ProviderSetting["provider"][] = [
    ...new Set([...configured.map((row) => row.provider), ...(profile.provider ? [profile.provider] : [])]),
  ];
  const saveReady =
    profile.modelId.trim().length > 0 &&
    providerChoices.length > 0 &&
    configured.some((row) => row.provider === profile.provider);
  const providerName = profile.provider === "xai" ? "xAI" : profile.provider[0]?.toUpperCase() + profile.provider.slice(1);
  const navBarPad = useNavBarPad();
  return (
    <View style={[styles.screen, navBarPad]}>
      <FormScroll
        contentContainerStyle={styles.pageScroll}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.markWrap} accessibilityRole="image" accessibilityLabel="Bot character">
          {profile.avatarUrl ? (
            <Image source={{ uri: profile.avatarUrl }} contentFit="cover" style={styles.markPhoto} />
          ) : (
            <LivingMark
              shape={mark.shape}
              color={mark.color}
              material={mark.material}
              style={mark.style}
              gender={mark.gender}
              size={168}
              mood="idle"
            />
          )}
        </View>
        <View style={styles.nameCard}>
          {/* The Chief of Staff's name and title are the product's, not the person's to change. */}
          {profile.kind === "support" ? (
            <>
              <Text style={styles.nameInput}>{profile.name}</Text>
              {profile.label && profile.label !== profile.name ? (
                <>
                  <View style={styles.nameDivider} />
                  <Text style={styles.titleInput}>{profile.label}</Text>
                </>
              ) : null}
            </>
          ) : (
            <>
              <TextInput
                value={profile.name}
                onChangeText={(name) => onChange({ ...profile, name })}
                style={styles.nameInput}
              />
              <View style={styles.nameDivider} />
              <TextInput
                value={profile.label}
                onChangeText={(label) => onChange({ ...profile, label })}
                placeholder="Title (optional)"
                placeholderTextColor={colors.muted}
                style={styles.titleInput}
              />
            </>
          )}
        </View>
        <View style={styles.tabs}>
          {TABS.map((entry) => (
            <Pressable
              key={entry.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === entry.id }}
              onPress={() => onTab(entry.id)}
              style={styles.tab}
            >
              <Text style={[styles.tabText, tab === entry.id ? styles.tabTextOn : null]}>{entry.label}</Text>
              {tab === entry.id ? <View style={styles.tabBar} /> : null}
            </Pressable>
          ))}
        </View>
        {tab !== "info" ? (
          <ShareTab tab={tab} messages={messages} onFetchBlob={onFetchBlob} />
        ) : (
          <View style={styles.scroll}>
            <Text style={styles.section}>Character</Text>
            <View style={styles.card}>
              <View style={styles.characterTabs}>
                {CHARACTER_TABS.map((entry) => (
                  <Pressable
                    key={entry.id}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: characterTab === entry.id }}
                    onPress={() => setCharacterTab(entry.id)}
                    style={styles.characterTab}
                  >
                    <Text style={[styles.characterTabText, characterTab === entry.id ? styles.characterTabOn : null]}>
                      {entry.label}
                    </Text>
                    {characterTab === entry.id ? <View style={styles.characterTabBar} /> : null}
                  </Pressable>
                ))}
              </View>
              {characterTab === "shape" ? (
                <View style={styles.shapeGrid}>
                  {MARK_SHAPES.map((entry) => (
                    <Pressable
                      key={entry.id}
                      accessibilityRole="button"
                      accessibilityLabel={entry.label}
                      accessibilityState={{ selected: !profile.avatarUrl && mark.shape === entry.id }}
                      onPress={() => onPickMark({ ...mark, shape: entry.id })}
                      style={styles.shapeCell}
                      disabled={Boolean(profile.avatarUrl)}
                    >
                      <View
                        style={[
                          styles.shapeRing,
                          !profile.avatarUrl && mark.shape === entry.id ? styles.ringOn : null,
                          profile.avatarUrl ? styles.colorDim : null,
                        ]}
                      >
                        <Mark
                          shape={entry.id}
                          color={mark.color}
                          material={mark.material}
                          style={mark.style}
                          gender={mark.gender}
                          size={44}
                        />
                      </View>
                    </Pressable>
                  ))}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Upload photo"
                    accessibilityState={{ selected: Boolean(profile.avatarUrl) }}
                    onPress={onPickAvatar}
                    style={styles.shapeCell}
                  >
                    <View style={[styles.shapeRing, styles.photoRing, profile.avatarUrl ? styles.ringOn : null]}>
                      {profile.avatarUrl ? (
                        <Image source={{ uri: profile.avatarUrl }} contentFit="cover" style={styles.photoThumb} />
                      ) : (
                        <Feather name="image" size={24} color={colors.muted} />
                      )}
                    </View>
                  </Pressable>
                </View>
              ) : null}
              {characterTab === "color" ? (
                <View style={styles.colorGrid}>
                  {MARK_COLORS.map((color) => (
                    <Pressable
                      key={color}
                      accessibilityRole="button"
                      accessibilityLabel={`Mark color ${color}`}
                      accessibilityState={{ selected: mark.color === color }}
                      onPress={() => onPickMark({ ...mark, color })}
                      style={styles.colorCell}
                      disabled={Boolean(profile.avatarUrl)}
                    >
                      <View
                        style={[
                          styles.colorRing,
                          mark.color === color && !profile.avatarUrl ? styles.ringOn : null,
                          profile.avatarUrl ? styles.colorDim : null,
                        ]}
                      >
                        <View style={[styles.dot, { backgroundColor: color }]} />
                      </View>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              {characterTab === "material" ? (
                <View style={styles.materialGrid}>
                  {MARK_MATERIALS.map((entry) => (
                    <Pressable
                      key={entry.id}
                      accessibilityRole="button"
                      accessibilityLabel={entry.label}
                      accessibilityState={{ selected: mark.material === entry.id }}
                      onPress={() => onPickMark({ ...mark, material: entry.id })}
                      style={styles.materialCell}
                      disabled={Boolean(profile.avatarUrl)}
                    >
                      <View
                        style={[
                          styles.materialChip,
                          mark.material === entry.id && !profile.avatarUrl ? styles.materialOn : null,
                          profile.avatarUrl ? styles.colorDim : null,
                        ]}
                      >
                        <Mark
                          shape={mark.shape}
                          color={mark.color}
                          material={entry.id}
                          style={mark.style}
                          gender={mark.gender}
                          size={32}
                        />
                        <Text style={styles.materialLabel} numberOfLines={1}>
                          {entry.label}
                        </Text>
                      </View>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              <View style={styles.resetDivider} />
              <Pressable accessibilityRole="button" onPress={onResetMark} style={styles.resetRow}>
                <Text style={styles.resetText}>Reset to default</Text>
              </Pressable>
            </View>
            <Text style={styles.caption}>Shape, color, and material tabs — or the image icon for a photo</Text>
            <Pressable accessibilityRole="button" onPress={onInstructions} style={styles.rowCard}>
              <IconDoc />
              <Text style={styles.rowLabel}>Instructions</Text>
              <IconChevron />
            </Pressable>
            <Text style={styles.section}>Routines</Text>
            <View style={styles.group}>
              {routines.length === 0 ? (
                <View style={styles.emptyRow}>
                  <Text style={styles.emptyText}>No routines yet — this bot adds them with its tools.</Text>
                </View>
              ) : null}
              {routines.map((routine) => (
                <Pressable
                  key={routine.id}
                  accessibilityRole="button"
                  onPress={() => onRoutine(routine)}
                  style={styles.routineRow}
                >
                  <IconClock />
                  <View style={styles.routineBody}>
                    <Text style={styles.routineTitle} numberOfLines={1}>
                      {routineTitle(routine)}
                    </Text>
                    <Text style={styles.routineSub} numberOfLines={1}>
                      {formatSchedule(routine.cron)}
                      {routine.paused ? " · Paused" : ""}
                    </Text>
                    <Text
                      style={[
                        styles.routineSub,
                        routine.lastRunStatus === "failed" ? styles.routineFailed : null,
                      ]}
                      numberOfLines={1}
                    >
                      Last run · {formatLastRun(routine.lastRunAt, routine.lastRunStatus, routine.timezone)}
                    </Text>
                  </View>
                  <IconChevron />
                </Pressable>
              ))}
            </View>
            <View style={styles.notifyCard}>
              <Text style={styles.rowLabel}>Notifications</Text>
              <Switch
                value={profile.notify}
                onValueChange={(notify) => onSaveNotify({ ...profile, notify })}
                trackColor={{ true: colors.green, false: colors.line }}
              />
            </View>
            <Text style={styles.caption}>Get notified when this Bot finishes or needs input</Text>
            <Text style={styles.section}>Advanced</Text>
            <View style={styles.group}>
              <Pressable accessibilityRole="button" onPress={onProvider} style={styles.providerRow}>
                <Text style={styles.rowLabel}>Provider</Text>
                <View style={styles.trailing}>
                  <Text style={styles.trailingText}>{providerName}</Text>
                  <IconChevron />
                </View>
              </Pressable>
              <View style={styles.advancedBlock}>
                <Text style={styles.advancedLabel}>Model id</Text>
                <TextInput
                  value={profile.modelId}
                  onChangeText={(modelId) => onChange({ ...profile, modelId })}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.input}
                />
              </View>
              {/* The Chief of Staff always stays pinned at the top and is never hidden. */}
              {profile.kind !== "support" ? (
                <>
                  <View style={styles.flagRow}>
                    <Text style={styles.rowLabel}>Pin</Text>
                    <Switch value={profile.pinned} onValueChange={(pinned) => onChange({ ...profile, pinned })} />
                  </View>
                  <View style={styles.flagRow}>
                    <Text style={styles.rowLabel}>Hide</Text>
                    <Switch value={profile.hidden} onValueChange={(hidden) => onChange({ ...profile, hidden })} />
                  </View>
                </>
              ) : null}
            </View>
            <PrimaryButton label="Save changes" disabled={!saveReady} onPress={onSave} style={styles.saveSpace} />
          </View>
        )}
      </FormScroll>
    </View>
  );
}

/**
 * Lists links, media, or files from this private chat.
 * Links are rows with the site's icon, its name and the address; media is a
 * grid of pictures and videos, including those sent as files; files are the
 * documents left over.
 */
function ShareTab({
  tab,
  messages,
  onFetchBlob,
}: {
  tab: Tab;
  messages: { conversationId?: string; body: string; blocks?: MessageBlock[] | null }[];
  onFetchBlob?: (conversationId: string, messageId: string, index: number) => Promise<{ url?: string; previewUrl?: string }>;
}) {
  const { width } = useWindowDimensions();
  const shares = collectShares(messages);
  const count = tab === "links" ? shares.links.length : tab === "media" ? shares.media.length : shares.files.length;
  if (count === 0) return <TabEmpty tab={tab} />;
  if (tab === "media") {
    const gap = 12;
    const size = Math.floor((width - 32 - gap) / 2);
    return (
      <View style={[styles.mediaGrid, { gap }]}>
        {shares.media.map((item, index) => {
          const fetchBlob =
            item.file?.conversationId && onFetchBlob
              ? (messageId: string, at: number) => onFetchBlob(item.file!.conversationId!, messageId, at)
              : undefined;
          return (
            <MediaThumb
              key={`${item.url}-${index}`}
              url={item.url}
              file={item.file ? { kind: "file", name: item.file.name, url: item.file.url, mime: item.file.mime, blobRef: item.file.blobRef } : undefined}
              video={item.video}
              fetchBlob={fetchBlob}
              size={size}
            />
          );
        })}
      </View>
    );
  }
  if (tab === "links") {
    return (
      <View style={styles.shareList}>
        {shares.links.map((link, index) => {
          const host = hostOf(link);
          return (
            <Pressable
              key={`${link}-${index}`}
              accessibilityRole="link"
              accessibilityLabel={`${host}, ${link}`}
              style={({ pressed }) => [styles.linkRow, index > 0 ? styles.linkDivider : null, pressed ? styles.rowPressed : null]}
              onPress={() => void Linking.openURL(link)}
            >
              <SiteIcon host={host} />
              <View style={styles.linkText}>
                <Text style={styles.linkHost} numberOfLines={1}>{host}</Text>
                <Text style={styles.linkUrl} numberOfLines={2}>{link}</Text>
              </View>
              <IconChevron />
            </Pressable>
          );
        })}
      </View>
    );
  }
  return (
    <View style={styles.shareList}>
      {shares.files.map((file, index) => (
        <Pressable
          key={`${file.name}-${index}`}
          accessibilityRole="button"
          style={({ pressed }) => [styles.linkRow, index > 0 ? styles.linkDivider : null, pressed ? styles.rowPressed : null]}
          onPress={() => openSharedFile(file, onFetchBlob)}
        >
          <View style={styles.fileIcon}>
            <IconDoc />
          </View>
          <View style={styles.linkText}>
            <Text style={styles.linkHost} numberOfLines={2}>{file.name}</Text>
            {file.mime ? <Text style={styles.linkUrl} numberOfLines={1}>{file.mime}</Text> : null}
          </View>
          <IconChevron />
        </Pressable>
      ))}
    </View>
  );
}

/** "https://www.youtube.com/shorts/x" as "www.youtube.com". */
function hostOf(link: string): string {
  try {
    return new URL(link).host || link;
  } catch {
    return link;
  }
}

/** The site's own icon, loaded from the site itself; a plain link mark when it has none. */
function SiteIcon({ host }: { host: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !host.includes(".")) {
    return (
      <View style={styles.siteIcon}>
        <Feather name="link" size={16} color={colors.muted} />
      </View>
    );
  }
  return (
    <Image
      source={{ uri: `https://${host}/favicon.ico` }}
      style={styles.siteIcon}
      contentFit="contain"
      onError={() => setFailed(true)}
      accessibilityIgnoresInvertColors
    />
  );
}

function openSharedFile(
  file: SharedFile | undefined,
  onFetchBlob?: (conversationId: string, messageId: string, index: number) => Promise<{ url?: string; previewUrl?: string }>,
): void {
  if (!file) return;
  const fetchBlob = file.conversationId && onFetchBlob
    ? (messageId: string, index: number) => onFetchBlob(file.conversationId!, messageId, index)
    : undefined;
  void openFileBlock({ kind: "file", name: file.name, url: file.url, mime: file.mime, blobRef: file.blobRef }, fetchBlob);
}

/** Shows the empty state for a private-chat tab with nothing shared yet. */
function TabEmpty({ tab }: { tab: Tab }) {
  const copy =
    tab === "links"
      ? { title: "No links yet", hint: "Links this bot shares will appear here." }
      : tab === "media"
        ? { title: "No media yet", hint: "Photos and videos from this conversation will appear here." }
        : { title: "No files yet", hint: "Files from this conversation will appear here." };
  return (
    <View style={styles.tabEmptyInline}>
      <Text style={styles.tabEmptyTitle}>{copy.title}</Text>
      <Text style={styles.tabEmptyHint}>{copy.hint}</Text>
    </View>
  );
}

/**
 * Edits the three identity fields that shape the bot's behavior.
 * Input: the profile draft and actions. Output: the instructions form.
 */
function InstructionsPage({
  profile,
  onChange,
  onSave,
}: {
  profile: RosterAgent;
  onChange: (profile: RosterAgent) => void;
  onSave: () => void | Promise<unknown>;
}) {
  // The default agent's role and job are set by the core; only its voice is the person's to change.
  const fixed = profile.kind === "support";
  const navBarPad = useNavBarPad();
  return (
    <View style={[styles.screen, navBarPad]}>
      <FormScroll contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {fixed ? null : (
          <>
            <Text style={styles.fieldLabel}>Role</Text>
            <TextInput
              value={profile.role}
              onChangeText={(role) => onChange({ ...profile, role })}
              style={styles.input}
            />
          </>
        )}
        <Text style={styles.fieldLabel}>Personality</Text>
        <TextInput
          value={profile.personality}
          onChangeText={(personality) => onChange({ ...profile, personality })}
          multiline
          style={styles.area}
        />
        {fixed ? null : (
          <>
            <Text style={styles.fieldLabel}>Job</Text>
            <TextInput
              value={profile.jobDescription}
              onChangeText={(jobDescription) => onChange({ ...profile, jobDescription })}
              multiline
              style={styles.area}
            />
          </>
        )}
        <PrimaryButton label="Save changes" onPress={onSave} style={styles.saveSpace} />
      </FormScroll>
    </View>
  );
}

/**
 * Picks the model provider as a dropdown page in the reference card style.
 * Input: the profile draft, providers, and actions. Output: the picker page.
 */
function ProviderPage({
  profile,
  providers,
  onSelect,
}: {
  profile: RosterAgent;
  providers: ProviderSetting[];
  onSelect: (provider: ProviderSetting["provider"]) => void;
}) {
  const navBarPad = useNavBarPad();
  const configured = providers.filter((row) => row.configured);
  const choices: ProviderSetting["provider"][] = [
    ...new Set([...configured.map((row) => row.provider), ...(profile.provider ? [profile.provider] : [])]),
  ];
  return (
    <View style={[styles.screen, navBarPad]}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.group}>
          {choices.map((name) => (
            <Pressable key={name} accessibilityRole="button" onPress={() => onSelect(name)} style={styles.providerChoice}>
              <Text style={styles.rowLabel}>{name === "xai" ? "xAI" : name[0]?.toUpperCase() + name.slice(1)}</Text>
              {configured.some((row) => row.provider === name) ? <Text style={styles.configured}>Configured</Text> : null}
              {profile.provider === name ? <IconCheck /> : null}
            </Pressable>
          ))}
        </View>
        {configured.length === 0 ? (
          <Text style={styles.caption}>Add an AI provider in the account menu first.</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

/**
 * Shows one routine in the detail layout: Active, Schedule,
 * Instruction, and Run history. Delete stays with agent tools / Auto-review.
 */
function RoutineDetailPage({
  routine,
  onPause,
  onLoadRuns,
  onBack,
}: {
  routine: Routine;
  onPause: (paused: boolean) => void;
  onLoadRuns: () => Promise<RoutineRun[]>;
  onBack: () => void;
}) {
  const [runs, setRuns] = useState<RoutineRun[]>(routine.recentRuns ?? []);
  const [showInstructions, setShowInstructions] = useState(false);
  const navBarPad = useNavBarPad();
  useEffect(() => {
    setRuns(routine.recentRuns ?? []);
    setShowInstructions(false);
    let cancelled = false;
    void onLoadRuns()
      .then((next) => {
        if (!cancelled) setRuns(next);
      })
      .catch(() => {
        // Keep the list snapshot if refresh fails.
      });
    return () => {
      cancelled = true;
    };
    // Refresh when opening this routine; avoid looping on unstable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routine.id]);

  const navigation = useNavigation();
  useLayoutEffect(() => {
    if (!showInstructions) return;
    navigation.setOptions({
      title: "Instruction",
      headerLeft: () => <HeaderBackButton tintColor={colors.text} onPress={() => setShowInstructions(false)} />,
    });
    return () => {
      navigation.setOptions({
        title: routineTitle(routine),
        headerLeft: () => <HeaderBackButton tintColor={colors.text} onPress={onBack} />,
      });
    };
  }, [navigation, onBack, routine, showInstructions]);

  if (showInstructions) {
    return (
      <View style={[styles.screen, navBarPad]}>
        <ScrollView contentContainerStyle={styles.routineScroll} showsVerticalScrollIndicator={false}>
          <View style={styles.card}>
            <Text style={styles.routineFullBody} selectable>
              {routine.instructions.trim()}
            </Text>
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.screen, navBarPad]}>
      <ScrollView contentContainerStyle={styles.routineScroll} showsVerticalScrollIndicator={false}>
        <View style={styles.activeCard}>
          <Text style={styles.rowLabel}>Active</Text>
          <Switch
            value={!routine.paused}
            onValueChange={(active) => onPause(!active)}
            trackColor={{ true: colors.green, false: colors.line }}
          />
        </View>

        <Text style={styles.routineSection}>Schedule</Text>
        <View style={styles.card}>
          <Text style={styles.scheduleLine}>{formatSchedule(routine.cron)}</Text>
          <View style={styles.nextRunRow}>
            <Text style={styles.metaLabel}>Next run</Text>
            <Text style={styles.metaValue}>
              {routine.paused ? "—" : formatNextRunRelative(routine.nextRunAt, routine.timezone)}
            </Text>
          </View>
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={() => setShowInstructions(true)}
          style={styles.instructionRow}
        >
          <Text style={styles.rowLabel}>Instruction</Text>
          <IconChevron />
        </Pressable>

        <Text style={styles.routineSection}>Run history</Text>
        <View style={styles.group}>
          {runs.length === 0 ? (
            <View style={styles.emptyRow}>
              <Text style={styles.emptyText}>No finished runs yet.</Text>
            </View>
          ) : (
            runs.map((run, index) => (
              <View
                key={run.id}
                style={[styles.historyRow, index === runs.length - 1 ? styles.historyRowLast : null]}
              >
                <Text style={styles.historyWhen}>
                  {formatRunHistoryWhen(run.runAt, routine.timezone)}
                </Text>
                <Text
                  style={[
                    styles.historyStatus,
                    run.status === "failed" ? styles.historyFail : styles.historyOk,
                  ]}
                >
                  {run.status === "failed" ? "Failed" : "Succeeded"}
                </Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 10, paddingTop: 2 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 4 },
  pageHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingTop: 4 },
  pageTitle: { color: colors.text, fontSize: 17, fontWeight: "600", flexShrink: 1 },
  spacer: { width: 44 },
  markWrap: { alignItems: "center", paddingTop: 8, minHeight: 176, justifyContent: "center" },
  markPhoto: { width: 168, height: 156, borderRadius: 40, borderCurve: "continuous" },
  // Narrow centered pill — not full-bleed, not a tiny island.
  nameCard: {
    alignSelf: "center",
    width: "58%",
    maxWidth: 240,
    minWidth: 180,
    marginTop: 12,
    backgroundColor: colors.bubble,
    borderRadius: 18,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  nameInput: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  nameDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginHorizontal: 14 },
  titleInput: {
    color: colors.text,
    fontSize: 15,
    textAlign: "center",
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  pageScroll: { paddingTop: 12, paddingBottom: 40 },
  tabs: {
    flexDirection: "row",
    marginTop: 14,
    marginHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  tab: { flex: 1, alignItems: "center", paddingVertical: 9 },
  tabText: { color: "#8E8E93", fontSize: 15, fontWeight: "500" },
  tabTextOn: { color: colors.text },
  tabBar: { position: "absolute", bottom: 0, width: 36, height: 2, borderRadius: 1, backgroundColor: colors.text },
  scroll: { paddingHorizontal: 16, paddingTop: 10, gap: 8 },
  section: { color: colors.muted, fontSize: 13, marginTop: 8, marginLeft: 4, marginBottom: -2 },
  card: {
    backgroundColor: colors.bubble,
    borderRadius: 18,
    borderCurve: "continuous",
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 4,
  },
  cardBody: { flex: 1, gap: 2 },
  characterTabs: { flexDirection: "row", marginBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  characterTab: { flex: 1, alignItems: "center", paddingVertical: 10 },
  characterTabText: { color: colors.muted, fontSize: 14, fontWeight: "500" },
  characterTabOn: { color: colors.text },
  characterTabBar: { position: "absolute", bottom: 0, width: 36, height: 2, borderRadius: 1, backgroundColor: colors.text },
  shapeGrid: { flexDirection: "row", flexWrap: "wrap" },
  shapeCell: { width: "25%", alignItems: "center", paddingVertical: 8 },
  shapeRing: {
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 1.5,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  photoRing: { backgroundColor: colors.control, overflow: "hidden" },
  photoThumb: { width: 68, height: 68, borderRadius: 34 },
  ringOn: { borderColor: "#636366" },
  colorGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 4 },
  colorCell: { width: "20%", alignItems: "center", paddingVertical: 5 },
  colorRing: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  colorDim: { opacity: 0.35 },
  dot: { width: 28, height: 28, borderRadius: 14 },
  materialGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 8 },
  materialCell: { width: "33.33%", paddingHorizontal: 3, paddingVertical: 3 },
  materialChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "transparent",
    backgroundColor: colors.control,
  },
  materialOn: { borderColor: "#636366" },
  materialLabel: { color: colors.text, fontSize: 11, fontWeight: "500", flexShrink: 1 },
  resetDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginTop: 8, marginHorizontal: 6 },
  resetRow: { paddingVertical: 12, paddingHorizontal: 6 },
  resetText: { color: colors.link, fontSize: 16 },
  caption: { color: colors.muted, fontSize: 12, marginHorizontal: 4, marginTop: -2, marginBottom: 4 },
  rowCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.bubble,
    borderRadius: 14,
    borderCurve: "continuous",
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  rowLabel: { color: colors.text, fontSize: 16, flex: 1 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  trailing: { flexDirection: "row", alignItems: "center", gap: 6 },
  trailingText: { color: colors.muted, fontSize: 15 },
  configured: { color: colors.green, fontSize: 13 },
  group: { backgroundColor: colors.bubble, borderRadius: 14, borderCurve: "continuous", overflow: "hidden" },
  routineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  routineHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  routineBody: { flex: 1, gap: 2 },
  routineTitle: { color: colors.text, fontSize: 16 },
  routineSub: { color: colors.muted, fontSize: 13 },
  routineFailed: { color: colors.danger },
  routineScroll: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 48, gap: 10 },
  routineNavTitle: { flex: 1, textAlign: "center", marginHorizontal: 4 },
  activeCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.bubble,
    borderRadius: 16,
    borderCurve: "continuous",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  routineSection: { color: colors.muted, fontSize: 13, fontWeight: "600", marginTop: 6, marginLeft: 4 },
  routineFullBody: { color: colors.text, fontSize: 16, lineHeight: 24 },
  scheduleLine: { color: colors.text, fontSize: 17, fontWeight: "500" },
  nextRunRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  instructionRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.bubble,
    borderRadius: 16,
    borderCurve: "continuous",
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  historyRowLast: { borderBottomWidth: 0 },
  historyWhen: { color: colors.text, fontSize: 16, flex: 1 },
  historyStatus: { fontSize: 16, fontWeight: "500" },
  historyOk: { color: colors.green },
  historyFail: { color: colors.danger },
  emptyRow: { paddingHorizontal: 16, paddingVertical: 14 },
  emptyText: { color: colors.muted, fontSize: 14 },
  notifyCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.bubble,
    borderRadius: 14,
    borderCurve: "continuous",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  providerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  providerChoice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  metaLabel: { color: colors.muted, fontSize: 15 },
  metaValue: { color: colors.muted, fontSize: 15 },
  detailsText: { color: colors.text, fontSize: 15, lineHeight: 22 },
  advancedBlock: { paddingHorizontal: 14, paddingTop: 12, gap: 8 },
  advancedLabel: { color: colors.text, fontSize: 15 },
  input: {
    backgroundColor: colors.control,
    color: colors.text,
    borderRadius: 12,
    borderCurve: "continuous",
    height: 44,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  fieldLabel: { color: colors.text, fontSize: 15, marginTop: 16, marginBottom: 6 },
  area: {
    backgroundColor: colors.bubble,
    color: colors.text,
    borderRadius: 12,
    borderCurve: "continuous",
    minHeight: 110,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    textAlignVertical: "top",
  },
  flagRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10 },
  save: {
    marginTop: 20,
    backgroundColor: colors.text,
    borderRadius: 22,
    borderCurve: "continuous",
    height: 46,
    alignItems: "center",
    justifyContent: "center",
  },
  saveDisabled: { opacity: 0.4 },
  saveText: { color: colors.bg, fontSize: 16, fontWeight: "600" },
  saveSpace: { marginTop: 20 },
  tabEmpty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 48 },
  shareList: { marginHorizontal: 16, marginTop: 12, backgroundColor: colors.bubble, borderRadius: 14, overflow: "hidden" },
  linkRow: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 14 },
  linkDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowPressed: { opacity: 0.6 },
  linkText: { flex: 1, gap: 3 },
  linkHost: { color: colors.text, fontSize: 17, fontWeight: "500" },
  linkUrl: { color: colors.muted, fontSize: 14, lineHeight: 19 },
  siteIcon: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: colors.card },
  fileIcon: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: colors.card },
  mediaGrid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: 16, marginTop: 12 },
  tabEmptyInline: { alignItems: "center", gap: 6, paddingHorizontal: 48, paddingVertical: 64 },
  tabEmptyTitle: { color: colors.text, fontSize: 17, fontWeight: "600" },
  tabEmptyHint: { color: colors.muted, fontSize: 14, textAlign: "center" },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
