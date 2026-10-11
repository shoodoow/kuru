import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View, Pressable } from "react-native";
import { defaultModelIds } from "@kuru/shared";
import type { ProviderSetting } from "../api";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { useResolvedScheme } from "../theme/appearance";
import { PrimaryButton } from "../ui/PrimaryButton";
import { pressableStyle } from "../ui/pressableStyles";

type Provider = ProviderSetting["provider"];

const providerChoices: { provider: Provider; label: string; keyFrom: string }[] = [
  { provider: "openai", label: "OpenAI", keyFrom: "platform.openai.com → API keys" },
  { provider: "anthropic", label: "Anthropic", keyFrom: "console.anthropic.com → API keys" },
  { provider: "xai", label: "xAI", keyFrom: "console.x.ai → API keys" },
  { provider: "local", label: "Other", keyFrom: "any OpenAI-compatible server: paste its address below" },
];

/**
 * The first screen of a new account: two steps, then the default agent says hello.
 * Why: agents cannot run without a provider key and a model, and a new person
 * had no way to know that or where to enter them.
 * Input: providers already saved, the account's default model if any, and the finish action.
 * Output: the setup form. Finishing saves the key and the default model.
 */
export function SetupGuide({
  providers,
  onFinish,
  onError,
}: {
  providers: ProviderSetting[];
  onFinish: (provider: Provider, secret: string, baseUrl: string | null, modelId: string) => Promise<void>;
  /** Shows a failure (a refused key, a wrong address or model) in the banner at the top. */
  onError: (error: unknown) => void;
}) {
  const saved = providers.find((row) => row.configured);
  const [provider, setProvider] = useState<Provider>(saved?.provider ?? "openai");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState(defaultModelIds[saved?.provider ?? "openai"] ?? "");
  const [error, setError] = useState<string | null>(null);
  useResolvedScheme();
  const choice = providerChoices.find((row) => row.provider === provider)!;
  const hasKey = providers.some((row) => row.provider === provider && row.configured);

  // Each provider names its models differently, so the suggestion follows the provider.
  useEffect(() => {
    setModelId(defaultModelIds[provider] ?? "");
    setSecret("");
    setBaseUrl(providers.find((row) => row.provider === provider)?.baseUrl ?? "");
  }, [provider, providers]);

  const keyReady = provider === "local" ? baseUrl.trim().length > 0 : hasKey || secret.trim().length > 0;
  const ready = keyReady && modelId.trim().length > 0;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.content}
    >
      <Text style={styles.title}>Two quick steps</Text>
      <Text style={styles.lead}>
        Your agents think with an AI model from a provider you choose. Add your key and pick a model, and your first agent
        will say hello.
      </Text>

      <Text style={styles.step}>1. Add your AI provider</Text>
      <View style={styles.choices}>
        {providerChoices.map((row) => (
          <Pressable
            key={row.provider}
            accessibilityRole="button"
            accessibilityState={{ selected: provider === row.provider }}
            onPress={() => setProvider(row.provider)}
            style={({ pressed }) => pressableStyle([styles.choice, provider === row.provider && styles.choiceOn], { pressed })}
          >
            <Text style={[styles.choiceText, provider === row.provider && styles.choiceTextOn]}>{row.label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.hint}>Get a key at {choice.keyFrom}. It is encrypted on the server and never shown again.</Text>
      {provider === "local" ? (
        <TextInput
          value={baseUrl}
          onChangeText={setBaseUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardAppearance="dark"
          placeholder="https://your-server/v1"
          placeholderTextColor={colors.muted}
          style={styles.input}
        />
      ) : null}
      <TextInput
        value={secret}
        onChangeText={setSecret}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        keyboardAppearance="dark"
        placeholder={hasKey ? "Key saved. Leave blank to keep it" : provider === "local" ? "API key (if your server needs one)" : "Paste your API key"}
        placeholderTextColor={colors.muted}
        style={styles.input}
      />

      <Text style={styles.step}>2. Choose your default model</Text>
      <Text style={styles.hint}>
        New agents start on this model. You can give any agent a different one later.
        {provider === "local" ? " Type the model id exactly as your server names it." : ""}
      </Text>
      <TextInput
        value={modelId}
        onChangeText={setModelId}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardAppearance="dark"
        placeholder="Model id"
        placeholderTextColor={colors.muted}
        style={styles.input}
      />

      <PrimaryButton
        label="Start"
        disabled={!ready}
        style={styles.start}
        onPress={() => {
          setError(null);
          return onFinish(provider, secret.trim(), provider === "local" ? baseUrl.trim() : null, modelId.trim()).catch(
            (failure: unknown) => {
              // Said twice on purpose: the banner is seen at once, the line stays for rereading.
              onError(failure);
              setError(failure instanceof Error ? failure.message : "Could not finish setup.");
            },
          );
        }}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    content: { padding: 20, paddingBottom: 40, gap: 10 },
    title: { color: colors.text, fontSize: 26, fontWeight: "700", marginTop: 12 },
    lead: { color: colors.muted, fontSize: 16, lineHeight: 22 },
    step: { color: colors.text, fontSize: 17, fontWeight: "600", marginTop: 18 },
    choices: { flexDirection: "row", gap: 8 },
    choice: { flex: 1, height: 40, borderRadius: 14, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" },
    choiceOn: { backgroundColor: colors.text },
    choiceText: { color: colors.text, fontSize: 14, fontWeight: "600" },
    choiceTextOn: { color: colors.bg },
    hint: { color: colors.muted, fontSize: 14, lineHeight: 19 },
    input: { backgroundColor: colors.card, color: colors.text, borderRadius: 14, height: 48, paddingHorizontal: 14, fontSize: 16 },
    start: { marginTop: 14 },
    error: { color: colors.danger, fontSize: 14 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
