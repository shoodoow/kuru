import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, type ViewStyle } from "react-native";
import type { ProviderSetting } from "../api";
import type { PluginList } from "../api";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { useAppearance, useResolvedScheme, type AppearanceChoice } from "../theme/appearance";
import { CustomPluginPage, PluginsPage } from "./PluginsPage";
import { Avatar } from "../ui/Avatar";
import { CardButton } from "../ui/CardButton";
import { PrimaryButton } from "../ui/PrimaryButton";
import { SettingsRow } from "../ui/SettingsRow";
import { pressableStyle } from "../ui/pressableStyles";
import { useSheetScrollStyle } from "../ui/sheet-scroll";
import { IconCheck, IconChevron, IconTrash } from "../ui/icons";

export type SignedAccount = {
  id: string;
  name: string;
  email: string;
};

export type MenuPage = "menu" | "account" | "signup" | "providers" | "plugins" | "plugin-custom" | "appearance";

/**
 * Shows the account menu, the account switcher, or signup.
 * Input: the signed-in accounts, the open page, and the menu actions.
 * Output: the account menu sheet.
 */
export function MenuSheet({
  page,
  account,
  accounts,
  notifications,
  autoReview,
  autoTimeZone,
  timeZone,
  providers,
  plugins,
  onPage,
  onNotifications,
  onAutoReview,
  onAutoTimeZone,
  onApprovals,
  onComputer,
  onSaveProvider,
  defaultModel,
  onSaveDefaultModel,
  onAddPlugin,
  onRemovePlugin,
  onRefreshPlugins,
  onSaveCustomPlugin,
  onSignInCustomPlugin,
  onGoogle,
  onSwitch,
  onSignOut,
  onDelete,
}: {
  defaultModel?: { provider: ProviderSetting["provider"]; modelId: string } | null;
  onSaveDefaultModel?: (provider: ProviderSetting["provider"], modelId: string) => void | Promise<unknown>;
  page: MenuPage;
  account: SignedAccount | null;
  accounts: SignedAccount[];
  notifications: boolean;
  autoReview: boolean;
  autoTimeZone: boolean;
  timeZone: string;
  providers: ProviderSetting[];
  plugins: PluginList | null;
  onPage: (page: MenuPage) => void;
  onNotifications: (value: boolean) => void;
  onAutoReview: (value: boolean) => void;
  onAutoTimeZone: (value: boolean) => void;
  onApprovals: () => void;
  onComputer: () => void;
  onSaveProvider: (provider: ProviderSetting["provider"], secret: string, baseUrl: string | null) => void | Promise<unknown>;
  onAddPlugin: (id: string) => void;
  onRemovePlugin: (id: string) => void;
  onRefreshPlugins: () => void;
  onSaveCustomPlugin: (name: string, url: string, secret: string) => void | Promise<unknown>;
  onSignInCustomPlugin: (name: string, url: string) => void;
  onGoogle: () => void;
  onSwitch: (id: string) => void;
  onSignOut: () => void;
  onDelete: (id: string) => void;
}) {
  useResolvedScheme();
  const scrollStyle = useSheetScrollStyle();
  return (
    <View style={styles.sheet}>
      {page === "menu" && account ? (
        <MenuPageView
          account={account}
          notifications={notifications}
          autoReview={autoReview}
          autoTimeZone={autoTimeZone}
          timeZone={timeZone}
          onAccount={() => onPage("account")}
          onNotifications={onNotifications}
          onAutoReview={onAutoReview}
          onAutoTimeZone={onAutoTimeZone}
          onApprovals={onApprovals}
          onComputer={onComputer}
          onProviders={() => onPage("providers")}
          onPlugins={() => onPage("plugins")}
          onAppearance={() => onPage("appearance")}
          scrollStyle={scrollStyle}
        />
      ) : null}
      {page === "account" && account ? (
        <AccountPage
          account={account}
          accounts={accounts}
          onAdd={() => onPage("signup")}
          onSwitch={onSwitch}
          onSignOut={onSignOut}
          onDelete={() => onDelete(account.id)}
          scrollStyle={scrollStyle}
        />
      ) : null}
      {page === "signup" ? (
        <SignupPage
          accounts={accounts}
          onGoogle={onGoogle}
          onSwitch={onSwitch}
          scrollStyle={scrollStyle}
        />
      ) : null}
      {page === "plugins" ? (
        <PluginsPage
          plugins={plugins}
          onCustom={() => onPage("plugin-custom")}
          onAdd={onAddPlugin}
          onRemove={onRemovePlugin}
          onRefresh={onRefreshPlugins}
          scrollStyle={scrollStyle}
        />
      ) : null}
      {page === "plugin-custom" ? (
        <CustomPluginPage onSave={onSaveCustomPlugin} onSignIn={onSignInCustomPlugin} scrollStyle={scrollStyle} />
      ) : null}
      {page === "appearance" ? <AppearancePage scrollStyle={scrollStyle} /> : null}
      {page === "providers" ? (
        <ProviderPage
          providers={providers}
          defaultModel={defaultModel}
          onSaveDefaultModel={onSaveDefaultModel}
          onSave={onSaveProvider}
          scrollStyle={scrollStyle}
        />
      ) : null}
    </View>
  );
}

function MenuPageView({
  account,
  notifications,
  autoReview,
  autoTimeZone,
  timeZone,
  onAccount,
  onNotifications,
  onAutoReview,
  onAutoTimeZone,
  onApprovals,
  onComputer,
  onProviders,
  onPlugins,
  onAppearance,
  scrollStyle,
}: {
  account: SignedAccount;
  notifications: boolean;
  autoReview: boolean;
  autoTimeZone: boolean;
  timeZone: string;
  onAccount: () => void;
  onNotifications: (value: boolean) => void;
  onAutoReview: (value: boolean) => void;
  onAutoTimeZone: (value: boolean) => void;
  onApprovals: () => void;
  onComputer: () => void;
  onProviders: () => void;
  onPlugins: () => void;
  onAppearance: () => void;
  scrollStyle: ViewStyle;
}) {
  const { choice } = useAppearance();
  return (
    <ScrollView style={scrollStyle} contentInsetAdjustmentBehavior="automatic" nestedScrollEnabled contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <CardButton onPress={onAccount}>
        <Avatar id={account.id} size={44} person label={account.name} />
        <View style={styles.cardBody}>
          <Text style={styles.name}>{account.name}</Text>
          <Text style={styles.email}>{account.email}</Text>
        </View>
        <IconChevron />
      </CardButton>
      <CardButton onPress={onApprovals}>
        <Text style={styles.rowLabel}>Usage</Text>
        <IconChevron />
      </CardButton>
      <CardButton onPress={onProviders}>
        <View style={styles.cardBody}>
          <Text style={styles.rowLabel}>AI Providers</Text>
          <Text style={styles.hint}>API keys and local OpenAI-compatible models</Text>
        </View>
        <IconChevron />
      </CardButton>
      <CardButton onPress={onPlugins}>
        <View style={styles.cardBody}>
          <Text style={styles.rowLabel}>Plugins</Text>
          <Text style={styles.hint}>Gmail, Calendar, Drive, and your own MCP servers</Text>
        </View>
        <IconChevron />
      </CardButton>
      <Text style={styles.section}>Bot</Text>
      <View style={styles.group}>
        <View style={styles.groupRow}>
          <View style={styles.cardBody}>
            <Text style={styles.rowLabel}>Auto-review</Text>
            <Text style={styles.hint}>Require approval for risky shell, MCP, and computer actions.</Text>
          </View>
          <Switch value={autoReview} onValueChange={onAutoReview} trackColor={{ true: colors.green, false: colors.line }} />
        </View>
        <SettingsRow onPress={onApprovals}>
          <Text style={styles.rowLabel}>Auto-review Rules</Text>
          <View style={styles.trailing}>
            <Text style={styles.trailingText}>Approvals</Text>
            <IconChevron />
          </View>
        </SettingsRow>
        <View style={styles.groupRow}>
          <View style={styles.cardBody}>
            <Text style={styles.rowLabel}>Set Time Zone Automatically</Text>
            <Text style={styles.hint}>Your Bot's computer follows this device's time zone.</Text>
          </View>
          <Switch value={autoTimeZone} onValueChange={onAutoTimeZone} trackColor={{ true: colors.green, false: colors.line }} />
        </View>
        <View style={styles.groupRow}>
          <Text style={styles.rowLabel}>Time Zone</Text>
          <Text style={styles.trailingText}>{timeZone}</Text>
        </View>
        <SettingsRow onPress={onComputer}>
          <Text style={styles.rowLabel}>Bot Computer</Text>
          <IconChevron />
        </SettingsRow>
      </View>
      <View style={styles.group}>
        <View style={styles.groupRow}>
          <Text style={styles.rowLabel}>Notifications</Text>
          <Switch value={notifications} onValueChange={onNotifications} trackColor={{ true: colors.green, false: colors.line }} />
        </View>
        <SettingsRow onPress={onAppearance}>
          <Text style={styles.rowLabel}>Appearance</Text>
          <View style={styles.trailing}>
            <Text style={styles.trailingText}>{appearanceLabel(choice)}</Text>
            <IconChevron />
          </View>
        </SettingsRow>
      </View>
    </ScrollView>
  );
}

const APPEARANCE_OPTIONS: { id: AppearanceChoice; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

function appearanceLabel(choice: AppearanceChoice): string {
  return APPEARANCE_OPTIONS.find((option) => option.id === choice)?.label ?? "System";
}

/**
 * Lets the person pick Light, Dark, or the device setting.
 */
function AppearancePage({ scrollStyle }: { scrollStyle: ViewStyle }) {
  const { choice, setChoice } = useAppearance();
  return (
    <ScrollView style={scrollStyle} contentInsetAdjustmentBehavior="automatic" nestedScrollEnabled contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <View style={styles.group}>
        {APPEARANCE_OPTIONS.map((option) => (
          <SettingsRow key={option.id} onPress={() => setChoice(option.id)}>
            <Text style={styles.rowLabel}>{option.label}</Text>
            {choice === option.id ? <IconCheck /> : null}
          </SettingsRow>
        ))}
      </View>
    </ScrollView>
  );
}

const providerNames: ProviderSetting["provider"][] = ["openai", "anthropic", "xai", "local"];

/**
 * Edits encrypted account-scoped provider credentials.
 * Input: configured providers and the save action.
 * Output: a provider picker with a secret field and local base URL.
 */
function ProviderPage({
  providers,
  defaultModel,
  onSaveDefaultModel,
  onSave,
  scrollStyle,
}: {
  defaultModel?: { provider: ProviderSetting["provider"]; modelId: string } | null;
  onSaveDefaultModel?: (provider: ProviderSetting["provider"], modelId: string) => void | Promise<unknown>;
  providers: ProviderSetting[];
  onSave: (provider: ProviderSetting["provider"], secret: string, baseUrl: string | null) => void | Promise<unknown>;
  scrollStyle: ViewStyle;
}) {
  const [provider, setProvider] = useState<ProviderSetting["provider"]>("openai");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const configured = providers.find((row) => row.provider === provider);
  const [modelId, setModelId] = useState("");

  useEffect(() => {
    setSecret("");
    setBaseUrl(configured?.baseUrl ?? "");
  }, [configured?.baseUrl, provider]);
  useEffect(() => {
    setModelId(defaultModel?.provider === provider ? defaultModel.modelId : "");
  }, [defaultModel?.provider, defaultModel?.modelId, provider]);

  const ready = provider === "local" ? baseUrl.trim().length > 0 : secret.trim().length > 0 || configured?.configured;
  return (
    <ScrollView style={scrollStyle} contentInsetAdjustmentBehavior="automatic" nestedScrollEnabled contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <Text style={styles.hint}>Keys are encrypted on the server and never returned to this phone.</Text>
      <View style={styles.group}>
        {providerNames.map((name) => (
          <SettingsRow key={name} onPress={() => setProvider(name)}>
            <Text style={styles.rowLabel}>{name === "xai" ? "xAI" : name[0]?.toUpperCase() + name.slice(1)}</Text>
            {providers.some((row) => row.provider === name && row.configured) ? <Text style={styles.configured}>Configured</Text> : null}
            {provider === name ? <IconCheck /> : null}
          </SettingsRow>
        ))}
      </View>
      <TextInput
        value={secret}
        onChangeText={setSecret}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        keyboardAppearance="dark"
        placeholder={configured?.configured ? "Leave blank to keep current key" : provider === "local" ? "Optional local key" : "API key"}
        placeholderTextColor={colors.muted}
        style={styles.input}
      />
      {provider === "local" ? (
        <TextInput
          value={baseUrl}
          onChangeText={setBaseUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardAppearance="dark"
          placeholder="https://your-openai-compatible-server/v1"
          placeholderTextColor={colors.muted}
          style={styles.input}
        />
      ) : null}
      <PrimaryButton
        label="Save provider"
        disabled={!ready}
        onPress={() => onSave(provider, secret, provider === "local" ? baseUrl.trim() : null)}
      />
      {onSaveDefaultModel && configured?.configured ? (
        <>
          <Text style={styles.hint}>
            {defaultModel
              ? `New agents start on ${defaultModel.provider} · ${defaultModel.modelId}. To change it, enter a model for the provider selected above.`
              : "Choose the model new agents start on."}
          </Text>
          <TextInput
            value={modelId}
            onChangeText={setModelId}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardAppearance="dark"
            placeholder="Default model id"
            placeholderTextColor={colors.muted}
            style={styles.input}
          />
          <PrimaryButton
            label="Use as default model"
            variant="secondary"
            disabled={modelId.trim().length === 0}
            onPress={() => onSaveDefaultModel(provider, modelId.trim())}
          />
        </>
      ) : null}
    </ScrollView>
  );
}

function AccountPage({
  account,
  accounts,
  onAdd,
  onSwitch,
  onSignOut,
  onDelete,
  scrollStyle,
}: {
  account: SignedAccount;
  accounts: SignedAccount[];
  onAdd: () => void;
  onSwitch: (id: string) => void;
  onSignOut: () => void;
  onDelete: () => void;
  scrollStyle: ViewStyle;
}) {
  return (
    <ScrollView style={scrollStyle} contentInsetAdjustmentBehavior="automatic" nestedScrollEnabled contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <View style={styles.card}>
        <Avatar id={account.id} size={44} person label={account.name} />
        <View style={styles.cardBody}>
          <Text style={styles.name}>{account.name}</Text>
          <Text style={styles.email}>{account.email}</Text>
        </View>
      </View>
      <Text style={styles.section}>Switch Account</Text>
      <View style={styles.group}>
        {accounts.map((row) => (
          <SettingsRow key={row.id} onPress={() => onSwitch(row.id)}>
            <Text style={styles.rowLabel}>{row.email}</Text>
            {row.id === account.id ? <IconCheck /> : null}
          </SettingsRow>
        ))}
        <SettingsRow onPress={onAdd}>
          <Text style={styles.rowLabel}>+  Add Account</Text>
        </SettingsRow>
      </View>
      <Pressable accessibilityRole="button" onPress={onSignOut} style={(state) => pressableStyle(styles.dangerButton, state)}>
        <Text style={styles.dangerText}>Sign Out</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={onDelete} style={(state) => pressableStyle(styles.dangerButton, state)}>
        <IconTrash />
        <Text style={styles.dangerText}>Delete Account</Text>
      </Pressable>
      <Text style={styles.caption}>Removes this account from the phone. This can't be undone here.</Text>
    </ScrollView>
  );
}

/**
 * Starts Google sign-in on the core.
 * Input: accounts already on this phone, and the Google and switch handlers.
 * Output: the sign-in page. The account id comes back from the Google session.
 */
function SignupPage({
  accounts,
  onGoogle,
  onSwitch,
  scrollStyle,
}: {
  accounts: SignedAccount[];
  onGoogle: () => void;
  onSwitch: (id: string) => void;
  scrollStyle: ViewStyle;
}) {
  return (
    <ScrollView style={scrollStyle} contentInsetAdjustmentBehavior="automatic" nestedScrollEnabled contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <Text style={styles.hint}>Google creates your account. Chats and groups use that account id.</Text>
      <PrimaryButton label="Continue with Google" onPress={onGoogle} />
      {accounts.length > 0 ? <Text style={styles.section}>On this phone</Text> : null}
      {accounts.map((row) => (
        <CardButton key={row.id} onPress={() => onSwitch(row.id)}>
          <Text style={styles.rowLabel}>{row.email}</Text>
        </CardButton>
      ))}
    </ScrollView>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.sheet },
  scroll: { padding: 14, paddingBottom: 28, gap: 10 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  cardBody: { flex: 1, gap: 2 },
  name: { color: colors.text, fontSize: 17, fontWeight: "600" },
  email: { color: colors.muted, fontSize: 14 },
  rowLabel: { color: colors.text, fontSize: 16, flex: 1 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  section: { color: colors.muted, fontSize: 13, marginTop: 8, marginLeft: 6 },
  group: { backgroundColor: colors.card, borderRadius: 16, borderCurve: "continuous", overflow: "hidden" },
  groupRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  trailing: { flexDirection: "row", alignItems: "center", gap: 6 },
  trailingText: { color: colors.muted, fontSize: 15 },
  configured: { color: colors.green, fontSize: 13 },
  accountHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  accountTitle: { color: colors.text, fontSize: 20, fontWeight: "600" },
  dangerButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.card,
    borderRadius: 16,
    height: 52,
  },
  dangerText: { color: colors.danger, fontSize: 16, fontWeight: "600" },
  caption: { color: colors.muted, fontSize: 13, lineHeight: 18, marginHorizontal: 6 },
  signupTitle: { color: colors.text, fontSize: 28, fontWeight: "700", marginTop: 8 },
  input: {
    backgroundColor: colors.card,
    color: colors.text,
    borderRadius: 14,
    height: 48,
    paddingHorizontal: 14,
    fontSize: 16,
  },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
