import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View, type ViewStyle } from "react-native";
import type { ProviderSetting } from "../api";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { FormScroll } from "../ui/FormScroll";
import { PrimaryButton } from "../ui/PrimaryButton";
import { SettingsRow } from "../ui/SettingsRow";
import { IconCheck } from "../ui/icons";

type Provider = ProviderSetting["provider"];
type ModelChoice = { provider: Provider; modelId: string };

/** A provider's name as people know it. */
export function providerLabel(name: string): string {
  if (name === "xai") return "xAI";
  if (name === "openai") return "OpenAI";
  if (name === "local") return "Local";
  return name[0]?.toUpperCase() + name.slice(1);
}

/** A model id to show as an example, so people know what to type. */
const EXAMPLES: Partial<Record<Provider, { main: string; background: string }>> = {
  anthropic: { main: "claude-opus-5-5", background: "claude-haiku-5-5" },
  openai: { main: "gpt-5", background: "gpt-5-mini" },
};

/**
 * Chooses the two models the account runs on: the main one agents chat
 * with, and the one background work runs on.
 * Why: the background model sat inside one provider's key page, so it could
 * only come from that provider. Each model is now chosen on its own, from any
 * provider that has a key: Opus to talk to, a GPT model for the work.
 * Input: the providers with their key state, the two saved models and their savers.
 */
export function ModelsPage({
  providers,
  mainModel,
  backgroundModel,
  onSaveMain,
  onSaveBackground,
  onProviders,
  onError,
  scrollStyle,
}: {
  providers: ProviderSetting[];
  mainModel: ModelChoice | null;
  /** Null when background work runs on each agent's own model. */
  backgroundModel: ModelChoice | null;
  onSaveMain: (provider: Provider, modelId: string) => void | Promise<unknown>;
  /** A null model id goes back to each agent's own model. */
  onSaveBackground: (provider: Provider, modelId: string | null) => void | Promise<unknown>;
  /** Opens the page where keys are added. */
  onProviders: () => void;
  onError: (error: unknown) => void;
  scrollStyle: ViewStyle;
}) {
  const ready = providers.filter((row) => row.configured).map((row) => row.provider);
  if (ready.length === 0) {
    return (
      <FormScroll style={scrollStyle} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.scroll}>
        <Text style={styles.hint}>Add an API key first. Models come from the providers you have a key for.</Text>
        <PrimaryButton label="Add a provider" onPress={onProviders} />
      </FormScroll>
    );
  }
  return (
    <FormScroll style={scrollStyle} contentInsetAdjustmentBehavior="automatic" nestedScrollEnabled contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <ModelSection
        title="Main model"
        explain="Your agents think and talk with you on this one. New agents start on it; each agent can still be given its own."
        current={mainModel ? `Now: ${providerLabel(mainModel.provider)} · ${mainModel.modelId}` : "Not chosen yet."}
        ready={ready}
        saved={mainModel}
        example="main"
        saveLabel="Use as main model"
        onSave={(provider, modelId) => onSaveMain(provider, modelId)}
        onError={onError}
      />
      <ModelSection
        title="Background model"
        explain="Workers use this for hands-on jobs and routines: browsing, building files, posting. That is where most tokens go, so a fast, cheaper model here saves the most. Chats with you stay on the main model."
        current={
          backgroundModel
            ? `Now: ${providerLabel(backgroundModel.provider)} · ${backgroundModel.modelId}`
            : "Now: the same model as the agent that starts the work."
        }
        ready={ready}
        saved={backgroundModel}
        example="background"
        saveLabel="Use for background work"
        onSave={(provider, modelId) => onSaveBackground(provider, modelId)}
        onClear={backgroundModel ? () => onSaveBackground(backgroundModel.provider, null) : undefined}
        clearLabel="Use each agent's own model"
        onError={onError}
      />
      <Text style={styles.caption}>
        A model needs its provider's key, under AI Providers. If that key is removed, background work goes back to each agent's own model.
      </Text>
    </FormScroll>
  );
}

/** One model choice: which provider, which model id, and the button that saves it. */
function ModelSection({
  title,
  explain,
  current,
  ready,
  saved,
  example,
  saveLabel,
  onSave,
  onClear,
  clearLabel,
  onError,
}: {
  title: string;
  explain: string;
  current: string;
  ready: Provider[];
  saved: ModelChoice | null;
  example: "main" | "background";
  saveLabel: string;
  onSave: (provider: Provider, modelId: string) => void | Promise<unknown>;
  onClear?: () => void | Promise<unknown>;
  clearLabel?: string;
  onError: (error: unknown) => void;
}) {
  const [provider, setProvider] = useState<Provider>(saved && ready.includes(saved.provider) ? saved.provider : ready[0]!);
  const [modelId, setModelId] = useState(saved?.provider === provider ? saved.modelId : "");
  // Why the last save was refused; it stays under the button that was pressed.
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    setModelId(saved?.provider === provider ? saved.modelId : "");
    setFailure(null);
  }, [saved?.provider, saved?.modelId, provider]);

  function run(action: () => void | Promise<unknown>): void {
    setFailure(null);
    void Promise.resolve()
      .then(action)
      .catch((error: unknown) => {
        onError(error);
        setFailure(error instanceof Error ? error.message : "Could not save.");
      });
  }
  const sample = EXAMPLES[provider]?.[example];
  const changed = modelId.trim().length > 0 && !(saved?.provider === provider && saved.modelId === modelId.trim());
  return (
    <>
      <Text style={styles.section}>{title}</Text>
      <Text style={styles.hint}>{explain}</Text>
      <Text style={styles.current}>{current}</Text>
      <View style={styles.group}>
        {ready.map((name) => (
          <SettingsRow key={name} onPress={() => setProvider(name)}>
            <Text style={styles.rowLabel}>{providerLabel(name)}</Text>
            {provider === name ? <IconCheck /> : null}
          </SettingsRow>
        ))}
      </View>
      <TextInput
        value={modelId}
        onChangeText={setModelId}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={sample ? `Model id, such as ${sample}` : "Model id, as your provider names it"}
        placeholderTextColor={colors.muted}
        style={styles.input}
      />
      <PrimaryButton label={saveLabel} variant="secondary" disabled={!changed} onPress={() => run(() => onSave(provider, modelId.trim()))} />
      {onClear && clearLabel ? <PrimaryButton label={clearLabel} variant="secondary" onPress={() => run(onClear)} /> : null}
      {failure ? <Text style={styles.error}>{failure}</Text> : null}
    </>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    scroll: { padding: 14, paddingBottom: 28, gap: 10 },
    section: { color: colors.text, fontSize: 17, fontWeight: "600", marginTop: 8, marginLeft: 6 },
    hint: { color: colors.muted, fontSize: 13, lineHeight: 18, marginHorizontal: 6 },
    current: { color: colors.text, fontSize: 14, marginHorizontal: 6 },
    caption: { color: colors.muted, fontSize: 13, lineHeight: 18, marginHorizontal: 6, marginTop: 8 },
    error: { color: colors.danger, fontSize: 14, lineHeight: 19, marginHorizontal: 6 },
    rowLabel: { color: colors.text, fontSize: 16, flex: 1 },
    group: { backgroundColor: colors.card, borderRadius: 16, borderCurve: "continuous", overflow: "hidden" },
    input: { backgroundColor: colors.card, color: colors.text, borderRadius: 14, height: 48, paddingHorizontal: 14, fontSize: 16 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
