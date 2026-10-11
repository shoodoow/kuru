import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions, type StyleProp, type ViewStyle } from "react-native";
import type { MessageBlock, RosterAgent } from "../api";
import { blocksFromMaybeWidgetText } from "@nano-agents/shared";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { Avatar } from "../ui/Avatar";
import { IconCheck, IconClose, IconMonitor, IconShield } from "../ui/icons";
import { FileCard } from "./FileViewer";
import { CopyButton, HorizontalTableScroll, MarkdownText } from "./MarkdownText";
import { ImageGroup, VideoBlock, isVideoBlock, openFileBlock, type FetchBlob, type ImageBlock } from "./media";

export { openFileBlock };

type BlockHandlers = {
  messageId?: string;
  onApprove?: (approvalId?: string) => void;
  onDeny?: (approvalId?: string) => void;
  onSubmitPoll?: (text: string) => void;
  onQuestionPick?: (messageId: string, pick: { value: string; label: string }) => void;
  onSubmitSecret?: (name: string, secret: string) => Promise<void>;
  onOpenDesktop?: () => void;
  onOpenAgent?: (agentId: string) => void;
  /** Looks an agent up by id, so an agent card can show its face and role. */
  agentInfo?: (agentId: string) => RosterAgent | undefined;
  fetchBlob?: FetchBlob;
};

/**
 * Renders every block of one message, in order.
 * Why: pictures that sit next to each other belong together, so a run of
 * image blocks becomes one album instead of a stack of full-size photos.
 * Only words go in a chat bubble: with `bubbleStyle`, each run of text blocks
 * is wrapped in one, and cards, pictures, files and code stand on their own,
 * since they already have a surface and a bubble around a card reads as a box in a box.
 * Input: the blocks, the handlers BlockView takes, an optional bubble style,
 * and an optional `lead` (a reply quote) shown at the top of the first bubble.
 * Output: the views.
 */
export function MessageBlocks({
  blocks,
  bubbleStyle,
  lead,
  ...handlers
}: BlockHandlers & { blocks: MessageBlock[]; bubbleStyle?: StyleProp<ViewStyle>; lead?: ReactNode }) {
  const groups: (MessageBlock | ImageBlock[])[] = [];
  for (const block of blocks) {
    const last = groups[groups.length - 1];
    if (block.kind === "image" && Array.isArray(last)) last.push(block);
    else groups.push(block.kind === "image" ? [block] : block);
  }
  const render = (group: MessageBlock | ImageBlock[], key: number) =>
    Array.isArray(group) ? (
      <ImageGroup key={key} images={group} fetchBlob={handlers.fetchBlob} />
    ) : (
      <BlockView key={key} block={group} {...handlers} />
    );
  if (!bubbleStyle) {
    return <>{groups.map(render)}</>;
  }
  // Runs of text become one bubble each; everything else is a segment of its own.
  const segments: { text: boolean; groups: (MessageBlock | ImageBlock[])[] }[] = [];
  for (const group of groups) {
    const text = !Array.isArray(group) && group.kind === "text";
    const last = segments[segments.length - 1];
    if (text && last?.text) last.groups.push(group);
    else segments.push({ text, groups: [group] });
  }
  const firstText = segments.findIndex((segment) => segment.text);
  return (
    <>
      {lead && firstText === -1 ? <View style={bubbleStyle}>{lead}</View> : null}
      {segments.map((segment, index) =>
        segment.text ? (
          <View key={index} style={bubbleStyle}>
            {index === firstText ? lead : null}
            {segment.groups.map(render)}
          </View>
        ) : (
          render(segment.groups[0]!, index)
        ),
      )}
    </>
  );
}

/**
 * Renders one rich MessageBlock.
 * Why: send_message turns carry text/image/code/file/widget payloads; the
 * thread must show them inline instead of raw JSON or bare URLs.
 * Oversized images arrive as blobRefs (bytes stripped from lists) and resolve
 * lazily through fetchBlob; everything else renders inline.
 * Input: block + optional approve/deny handlers + blob fetcher.
 * Output: the block view. Unknown widgets fall back to a summary line.
 */
export function BlockView({
  block,
  messageId,
  onApprove,
  onDeny,
  onSubmitPoll,
  onQuestionPick,
  onSubmitSecret,
  onOpenDesktop,
  onOpenAgent,
  agentInfo,
  fetchBlob,
}: BlockHandlers & { block: MessageBlock }) {
  if (block.kind === "text") {
    if (/\[widget:/i.test(block.markdown)) {
      const recovered = blocksFromMaybeWidgetText(block.markdown);
      if (recovered.some((row) => row.kind === "widget")) {
        return (
          <View style={{ gap: 8 }}>
            {recovered.map((row, index) => (
              <BlockView
                key={index}
                block={row}
                messageId={messageId}
                onApprove={onApprove}
                onDeny={onDeny}
                onSubmitPoll={onSubmitPoll}
                onQuestionPick={onQuestionPick}
                onSubmitSecret={onSubmitSecret}
                onOpenDesktop={onOpenDesktop}
                onOpenAgent={onOpenAgent}
                agentInfo={agentInfo}
                fetchBlob={fetchBlob}
              />
            ))}
          </View>
        );
      }
    }
    return <MarkdownText text={block.markdown} />;
  }
  if (block.kind === "image") {
    return <ImageGroup images={[block]} fetchBlob={fetchBlob} />;
  }
  if (block.kind === "code") {
    return (
      <View style={styles.codeWrap}>
        <View style={styles.codeHead}>
          <Text style={styles.codeLang}>{block.language ?? "code"}</Text>
          <CopyButton text={block.code} />
        </View>
        <Text style={styles.code}>{block.code}</Text>
      </View>
    );
  }
  if (block.kind === "file") {
    if (isVideoBlock(block)) {
      return <VideoBlock block={block} fetchBlob={fetchBlob} />;
    }
    return <FileCard block={block} fetchBlob={fetchBlob} />;
  }
  return (
    <WidgetView
      widget={block.widget}
      props={block.props}
      messageId={messageId}
      onApprove={onApprove}
      onDeny={onDeny}
      onSubmitPoll={onSubmitPoll}
      onQuestionPick={onQuestionPick}
      onSubmitSecret={onSubmitSecret}
      onOpenDesktop={onOpenDesktop}
      onOpenAgent={onOpenAgent}
      agentInfo={agentInfo}
    />
  );
}

/**
 * Renders interactive widget cards (checklist/chart/approval/agent-card,
 * poll/table/secret). Why: widgets are how agents deliver structured work
 * (plans, scores, review queues, polls, tables, secret prompts) without
 * pasting tables; approval cards wire directly to decide(), polls answer
 * into the chat, and secrets save to the write-only vault.
 * Input: widget kind + props + handlers. Output: card view or fallback text.
 */
function WidgetView(input: Parameters<typeof WidgetBody>[0]) {
  // Cards take the full width a message may use (85% of the thread, the same
  // limit as a text bubble), so option labels have room and cards line up.
  const { width } = useWindowDimensions();
  return (
    <View style={{ width: Math.min(Math.floor((width - 24) * 0.85), 460) }}>
      <WidgetBody {...input} />
    </View>
  );
}

function WidgetBody({
  widget,
  props,
  messageId,
  onApprove,
  onDeny,
  onSubmitPoll,
  onQuestionPick,
  onSubmitSecret,
  onOpenDesktop,
  onOpenAgent,
  agentInfo,
}: {
  agentInfo?: (agentId: string) => RosterAgent | undefined;
  widget: string;
  props: Record<string, unknown>;
  messageId?: string;
  onApprove?: (approvalId?: string) => void;
  onDeny?: (approvalId?: string) => void;
  onSubmitPoll?: (text: string) => void;
  onQuestionPick?: (messageId: string, pick: { value: string; label: string }) => void;
  onSubmitSecret?: (name: string, secret: string) => Promise<void>;
  onOpenDesktop?: () => void;
  onOpenAgent?: (agentId: string) => void;
}) {
  if (widget === "checklist") {
    const items = Array.isArray(props.items) ? (props.items as { label: string; done?: boolean }[]) : [];
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{String(props.title ?? "Checklist")}</Text>
        {items.map((item, index) => (
          <Text key={index} style={styles.cardLine}>
            {item.done ? "✅" : "⬜"} {item.label}
          </Text>
        ))}
      </View>
    );
  }
  if (widget === "chart") {
    const values = Array.isArray(props.values) ? (props.values as number[]) : [];
    const max = Math.max(1, ...values);
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{String(props.title ?? "Chart")}</Text>
        {values.map((value, index) => (
          <View key={index} style={styles.barRow}>
            <View style={[styles.bar, { flex: Math.max(0.05, value / max) }]} />
            <Text style={styles.barValue}>{String(value)}</Text>
          </View>
        ))}
      </View>
    );
  }
  if (widget === "approval") {
    const approvalId = typeof props.approvalId === "string" ? props.approvalId : undefined;
    const status = props.status === "approved" || props.status === "denied" ? props.status : null;
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{String(props.title ?? "Needs approval")}</Text>
        {props.detail ? <Text style={styles.cardLine}>{String(props.detail)}</Text> : null}
        {status ? (
          <Text style={styles.approvalStatus}>{status === "approved" ? "Approved" : "Denied"}</Text>
        ) : (
          <View style={styles.approvalRow}>
            <Pressable style={[styles.choice, styles.allow]} onPress={() => onApprove?.(approvalId)}>
              <Text style={styles.choiceText}>Approve</Text>
            </Pressable>
            <Pressable style={[styles.choice, styles.deny]} onPress={() => onDeny?.(approvalId)}>
              <Text style={styles.choiceText}>Deny</Text>
            </Pressable>
          </View>
        )}
      </View>
    );
  }
  if (widget === "agent-card") {
    const agentId = typeof props.agentId === "string" ? props.agentId : "";
    const known = agentId ? agentInfo?.(agentId) : undefined;
    const label = known?.label || known?.name || String(props.label ?? props.name ?? "New agent");
    const role = known?.role?.trim() || (typeof props.role === "string" ? props.role.trim() : "");
    const canOpen = Boolean(agentId && onOpenAgent);
    return (
      <View style={styles.surface}>
        <View style={styles.agentHead}>
          <Avatar
            id={agentId || label}
            size={48}
            round
            shape={known?.markShape ?? null}
            color={known?.markColor ?? null}
            material={known?.markMaterial ?? null}
            style={known?.markStyle ?? null}
            gender={known?.markGender ?? null}
            photo={known?.avatarUrl ?? null}
          />
          <View style={styles.agentText}>
            <Text style={styles.agentName} numberOfLines={1}>
              {label}
            </Text>
            <Text style={styles.agentRole} numberOfLines={2}>
              {role || "Joined your team"}
            </Text>
          </View>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open chat with ${label}`}
          disabled={!canOpen}
          onPress={() => agentId && onOpenAgent?.(agentId)}
          style={({ pressed }) => [styles.agentOpen, !canOpen ? styles.agentOpenOff : null, pressed ? styles.pressed : null]}
        >
          <Text style={styles.agentOpenText}>Open chat</Text>
        </Pressable>
      </View>
    );
  }
  if (widget === "poll") {
    return (
      <PollWidget
        title={String(props.title ?? props.question ?? "Pick one")}
        description={typeof props.description === "string" ? props.description : ""}
        options={parsePollOptions(props.options)}
        submitLabel={typeof props.submitLabel === "string" ? props.submitLabel : "Submit"}
        hint={typeof props.hint === "string" ? props.hint : "Or answer in the chat below"}
        onSubmit={onSubmitPoll}
      />
    );
  }
  if (widget === "question") {
    return (
      <QuestionWidget
        prompt={String(props.prompt ?? props.title ?? "Pick one")}
        helpText={typeof props.helpText === "string" ? props.helpText : ""}
        options={parseQuestionOptions(props.options)}
        allowCustom={props.allowCustom === true}
        selected={typeof props.selected === "string" ? props.selected : null}
        onPick={(pick) => {
          if (messageId && onQuestionPick) onQuestionPick(messageId, pick);
        }}
      />
    );
  }
  if (widget === "table") {
    return (
      <TableWidget
        title={typeof props.title === "string" ? props.title : ""}
        columns={parseStringArray(props.columns)}
        rows={Array.isArray(props.rows) ? props.rows.map((row) => parseStringArray(row)) : []}
        aligns={parseAligns(props.aligns)}
        note={typeof props.note === "string" ? props.note : ""}
      />
    );
  }
  if (widget === "desktop-handover") {
    const message =
      typeof props.message === "string" && props.message.trim()
        ? props.message.trim()
        : typeof props.title === "string" && props.title.trim()
          ? props.title.trim()
          : "Your agent needs you on the desktop.";
    const buttonLabel =
      typeof props.buttonLabel === "string" && props.buttonLabel.trim()
        ? props.buttonLabel.trim()
        : "Open desktop";
    return (
      <View style={styles.card}>
        <Text style={styles.cardLine}>{message}</Text>
        {typeof props.detail === "string" && props.detail.trim() ? (
          <Text style={styles.handoverDetail}>{props.detail.trim()}</Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          style={[styles.handoverBtn, !onOpenDesktop ? styles.handoverBtnDisabled : null]}
          disabled={!onOpenDesktop}
          onPress={() => onOpenDesktop?.()}
        >
          <IconMonitor />
          <Text style={styles.handoverBtnText}>{buttonLabel}</Text>
        </Pressable>
      </View>
    );
  }
  if (widget === "secret") {
    return (
      <SecretWidget
        title={String(props.title ?? "Password")}
        description={typeof props.description === "string" ? props.description : ""}
        envName={typeof props.envName === "string" ? props.envName : ""}
        placeholder={typeof props.placeholder === "string" ? props.placeholder : "Paste your secret"}
        buttonLabel={typeof props.buttonLabel === "string" ? props.buttonLabel : "Save securely"}
        footnote={
          typeof props.footnote === "string" ? props.footnote : "Stored securely, never shown to your Bot"
        }
        onSubmit={onSubmitSecret}
      />
    );
  }
  return <Text style={styles.body}>[widget:{widget}]</Text>;
}

const POLL_LETTERS = "ABCDEFGHIJKLMNOP";

type PollOption = { label: string; danger: boolean };

/** Normalizes poll options. Input: string[] or {label, danger}[]. Output: options. */
function parsePollOptions(raw: unknown): PollOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((item) => {
    if (typeof item === "string") {
      return item.trim() ? [{ label: item, danger: false }] : [];
    }
    if (item && typeof item === "object" && typeof (item as { label?: unknown }).label === "string") {
      const label = ((item as { label: string }).label ?? "").trim();
      return label ? [{ label, danger: (item as { danger?: unknown }).danger === true }] : [];
    }
    return [];
  });
}

type QuestionOption = {
  label: string;
  value: string;
  description: string;
  style: "default" | "primary" | "danger";
};

/** Normalizes question options. Input: {label, value?, description?, style?}[]. Output: up to 6 choices. */
function parseQuestionOptions(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((item) => {
    if (typeof item === "string") {
      const label = item.trim();
      return label ? [{ label, value: label, description: "", style: "default" as const }] : [];
    }
    if (!item || typeof item !== "object" || typeof (item as { label?: unknown }).label !== "string") {
      return [];
    }
    const row = item as { label: string; value?: unknown; description?: unknown; style?: unknown };
    const label = row.label.trim();
    if (!label) return [];
    const style: QuestionOption["style"] = row.style === "primary" || row.style === "danger" ? row.style : "default";
    const value = typeof row.value === "string" && row.value.trim() ? row.value.trim() : label;
    const description = typeof row.description === "string" ? row.description : "";
    return [{ label, value, description, style }];
  }).slice(0, 6);
}

/**
 * Single-choice card: a title, lettered rows in one inset list, and a hint
 * that typing an answer is fine too. A tap answers at once and stays on the
 * card (no chat bubble from the person).
 */
function QuestionWidget({
  prompt,
  helpText,
  options,
  allowCustom,
  selected,
  onPick,
}: {
  prompt: string;
  helpText: string;
  options: QuestionOption[];
  allowCustom: boolean;
  selected: string | null;
  onPick?: (pick: { value: string; label: string }) => void;
}) {
  const [picked, setPicked] = useState(selected);
  const [custom, setCustom] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const done = picked !== null && picked.length > 0;

  function pick(value: string, label: string): void {
    if (done || !onPick || !value.trim()) return;
    setPicked(value.trim());
    onPick({ value: value.trim(), label: label.trim() || value.trim() });
  }

  if (dismissed && !done) {
    return <Text style={styles.dismissed}>Question dismissed. You can still answer in the chat.</Text>;
  }
  return (
    <View style={styles.surface}>
      <View style={styles.pollHead}>
        <Text style={styles.pollTitle}>{prompt}</Text>
        {done ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss question"
            hitSlop={8}
            onPress={() => setDismissed(true)}
            style={styles.pollX}
          >
            <IconClose />
          </Pressable>
        )}
      </View>
      {helpText ? <Text style={styles.pollDesc}>{helpText}</Text> : null}
      <View style={styles.pollOptions}>
        {options.map((option, index) => {
          const on = picked === option.value;
          const letter = POLL_LETTERS[index] ?? String(index + 1);
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected: on, disabled: done }}
              accessibilityLabel={`${letter}. ${option.label}`}
              disabled={done}
              onPress={() => pick(option.value, option.label)}
              style={({ pressed }) => [
                styles.pollRow,
                index > 0 ? styles.pollDivider : null,
                on ? styles.pollRowOn : null,
                done && !on ? styles.questionRowDone : null,
                pressed ? styles.pollRowPressed : null,
              ]}
            >
              <View style={[styles.pollLetter, on ? styles.pollLetterOn : null]}>
                <Text style={[styles.pollLetterText, on ? styles.pollLetterTextOn : null]}>{letter}</Text>
              </View>
              <View style={styles.questionRowText}>
                <Text
                  style={[
                    styles.questionLabel,
                    option.style === "danger" ? styles.pollDanger : null,
                    option.style === "primary" ? styles.questionPrimaryLabel : null,
                  ]}
                  numberOfLines={3}
                >
                  {option.label}
                </Text>
                {option.description ? (
                  <Text style={styles.questionDescription} numberOfLines={2}>
                    {option.description}
                  </Text>
                ) : null}
              </View>
              {on ? <IconCheck /> : null}
            </Pressable>
          );
        })}
      </View>
      {allowCustom && !done ? (
        <View style={styles.secretRow}>
          <TextInput
            value={custom}
            onChangeText={setCustom}
            placeholder="Write your own answer"
            placeholderTextColor={colors.muted}
            keyboardAppearance="dark"
            style={styles.questionCustom}
          />
          <Pressable
            accessibilityRole="button"
            disabled={!custom.trim()}
            onPress={() => pick(custom, custom)}
            style={[styles.secretSave, custom.trim() ? styles.secretSaveReady : null]}
          >
            <Text style={[styles.secretSaveText, custom.trim() ? styles.secretSaveTextReady : null]}>OK</Text>
          </Pressable>
        </View>
      ) : null}
      <Text style={styles.pollHint}>{done ? "Answered" : allowCustom ? "Or write your own answer" : "Or answer in the chat below"}</Text>
    </View>
  );
}

/** Normalizes a string array prop. Input: unknown. Output: trimmed strings. */
function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is string => typeof item === "string").map((item) => item.trim());
}

/** Normalizes column aligns. Input: unknown. Output: per-column aligns or null. */
function parseAligns(raw: unknown): ("left" | "center" | "right")[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const aligns = raw.map((item) => (item === "center" || item === "right" ? item : "left"));
  return aligns.length > 0 ? aligns : null;
}

/**
 * Renders a multi-select poll card whose answer posts into the chat.
 * Why: "or answer in the chat below" — tapping options + Submit is the fast
 * path for structured picks (unlock lists, holds), typing stays available.
 * Danger options (holds) are exclusive: picking one clears the rest.
 * Input: title, description, options, labels, handlers. Output: the card.
 */
function PollWidget({
  title,
  description,
  options,
  submitLabel,
  hint,
  onSubmit,
}: {
  title: string;
  description: string;
  options: PollOption[];
  submitLabel: string;
  hint: string;
  onSubmit?: (text: string) => void;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  /** Toggles one option, keeping danger picks exclusive. */
  function toggle(index: number): void {
    if (submitted) {
      return;
    }
    setSelected((current) => {
      if (current.includes(index)) {
        return current.filter((picked) => picked !== index);
      }
      const next = options[index]?.danger ? [index] : [...current.filter((picked) => !options[picked]?.danger), index];
      return next;
    });
  }

  function submit(): void {
    if (selected.length === 0 || submitted || !onSubmit) {
      return;
    }
    const labels = selected
      .slice()
      .sort((a, b) => a - b)
      .map((index) => options[index]?.label ?? "")
      .filter((label) => label.length > 0);
    if (labels.length === 0) {
      return;
    }
    onSubmit(labels.join(", "));
    setSubmitted(true);
  }

  if (dismissed) {
    return <Text style={styles.dismissed}>Poll dismissed.</Text>;
  }
  const ready = selected.length > 0 && !submitted;
  return (
    <View style={styles.pollCard}>
      <View style={styles.pollHead}>
        <Text style={styles.pollTitle}>{title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss poll" onPress={() => setDismissed(true)} style={styles.pollX}>
          <IconClose />
        </Pressable>
      </View>
      {description ? <Text style={styles.pollDesc}>{description}</Text> : null}
      <View style={styles.pollOptions}>
        {options.map((option, index) => {
          const on = selected.includes(index);
          const letter = POLL_LETTERS[index] ?? String(index + 1);
          return (
            <Pressable
              key={index}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`${letter}. ${option.label}`}
              onPress={() => toggle(index)}
              style={[styles.pollRow, on ? styles.pollRowOn : null, index > 0 ? styles.pollDivider : null]}
            >
              <View style={[styles.pollLetter, on ? styles.pollLetterOn : null]}>
                <Text style={[styles.pollLetterText, on ? styles.pollLetterTextOn : null]}>{letter}</Text>
              </View>
              <Text style={[styles.pollLabel, option.danger ? styles.pollDanger : null]} numberOfLines={2}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {hint ? <Text style={styles.pollHint}>{hint}</Text> : null}
      <Pressable
        accessibilityRole="button"
        disabled={!ready}
        onPress={submit}
        style={[styles.pollSubmit, ready ? styles.pollSubmitReady : null]}
      >
        <Text style={[styles.pollSubmitText, ready ? styles.pollSubmitTextReady : null]}>
          {submitted ? "Submitted" : submitLabel}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * Renders a data table card with an optional closing note.
 * Why: agents deliver audits and lists as tables; plain text loses columns.
 * Input: title, columns, rows, aligns, note. Output: the table card.
 */
function TableWidget({
  title,
  columns,
  rows,
  aligns,
  note,
}: {
  title: string;
  columns: string[];
  rows: string[][];
  aligns: ("left" | "center" | "right")[] | null;
  note: string;
}) {
  const alignFor = (index: number): "left" | "center" | "right" => {
    if (aligns && aligns[index]) {
      return aligns[index] as "left" | "center" | "right";
    }
    return index === columns.length - 1 && columns.length > 1 ? "right" : "left";
  };
  const colStyle = (index: number) => [
    styles.tableCol,
    { textAlign: alignFor(index) as "left" | "center" | "right" },
  ];
  return (
    <View style={styles.pollCard}>
      {title ? <Text style={styles.pollTitle}>{title}</Text> : null}
      <HorizontalTableScroll>
        <View>
          <View style={styles.tableHead}>
            {columns.map((column, index) => (
              <Text key={index} style={[styles.tableHeader, ...colStyle(index)]}>
                {column}
              </Text>
            ))}
          </View>
          {rows.map((row, rowIndex) => (
            <View key={rowIndex} style={styles.tableRow}>
              {columns.map((_, colIndex) => (
                <Text key={colIndex} style={[styles.tableCell, ...colStyle(colIndex)]}>
                  {row[colIndex] ?? ""}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </HorizontalTableScroll>
      {note ? <Text style={styles.tableNote}>{note}</Text> : null}
    </View>
  );
}

/**
 * Renders a masked secret prompt whose value saves to the write-only vault.
 * Why: bots need tokens/passwords that must never appear in chat — the
 * input is masked, the button posts to /secrets, and the value clears.
 * Input: labels, env name, submit handler. Output: the secret card.
 */
function SecretWidget({
  title,
  description,
  envName,
  placeholder,
  buttonLabel,
  footnote,
  onSubmit,
}: {
  title: string;
  description: string;
  envName: string;
  placeholder: string;
  buttonLabel: string;
  footnote: string;
  onSubmit?: (name: string, secret: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = value.length > 0 && !busy && !!onSubmit;

  function change(text: string): void {
    setValue(text);
    setSaved(false);
  }

  function save(): void {
    if (!ready || !onSubmit) {
      return;
    }
    setBusy(true);
    void onSubmit(envName || title, value)
      .then(() => {
        setValue("");
        setSaved(true);
      })
      .catch(() => {
        // The app surfaces the error as a note; the typed value stays.
      })
      .finally(() => {
        setBusy(false);
      });
  }

  return (
    <View style={styles.pollCard}>
      <Text style={styles.pollTitle}>{title}</Text>
      {description ? <Text style={styles.pollDesc}>{description}</Text> : null}
      <View style={styles.secretStack}>
        <TextInput
          value={value}
          onChangeText={change}
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          keyboardAppearance="dark"
          style={styles.secretInput}
        />
        <Pressable
          accessibilityRole="button"
          disabled={!ready}
          onPress={save}
          style={[styles.secretSave, styles.secretSaveWide, ready ? styles.secretSaveReady : null]}
        >
          <Text style={[styles.secretSaveText, ready ? styles.secretSaveTextReady : null]}>
            {saved ? "Saved" : buttonLabel}
          </Text>
        </Pressable>
      </View>
      {footnote ? (
        <View style={styles.secretFoot}>
          <IconShield />
          <Text style={styles.secretFootText}>{footnote}</Text>
        </View>
      ) : null}
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  body: { color: colors.text, fontSize: 16, lineHeight: 24 },
  mdBold: { fontWeight: "700", color: colors.text },
  richStack: { gap: 8 },
  horizontalTableScroll: { marginHorizontal: -14, flexGrow: 0 },
  horizontalTableContent: { paddingHorizontal: 14, flexGrow: 1 },
  mdTableHead: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  mdTableHeader: { color: colors.text, fontSize: 13, fontWeight: "700", paddingVertical: 6, paddingRight: 12 },
  mdTableRow: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#2C2C2E" },
  mdTableCell: { color: colors.text, fontSize: 13, lineHeight: 18, paddingVertical: 6, paddingRight: 12 },
  mdCode: {
    fontFamily: "monospace",
    fontSize: 14,
    color: colors.text,
    backgroundColor: colors.control,
  },
  link: { color: colors.link },
  codeWrap: { backgroundColor: colors.control, borderRadius: 10, padding: 10, gap: 4 },
  codeHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16 },
  codeLang: { color: colors.muted, fontSize: 12 },
  codeCopy: { color: colors.link, fontSize: 12, fontWeight: "600" },
  code: { color: colors.text, fontFamily: "monospace", fontSize: 13 },
  fileWrap: { backgroundColor: colors.control, borderRadius: 10, padding: 12, gap: 2 },
  fileName: { color: colors.text, fontWeight: "600" },
  fileHint: { color: colors.muted, fontSize: 12 },
  // The card surface every widget stands on, now that cards sit on the chat
  // background instead of inside a bubble.
  surface: { backgroundColor: colors.bubble, borderRadius: 20, padding: 12, gap: 10 },
  pressed: { opacity: 0.6 },
  card: { backgroundColor: colors.bubble, borderRadius: 20, padding: 12, gap: 8 },
  agentHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  agentText: { flex: 1, gap: 2 },
  agentName: { color: colors.text, fontSize: 18, fontWeight: "600" },
  agentRole: { color: colors.muted, fontSize: 14, lineHeight: 19 },
  agentOpen: { height: 46, borderRadius: 14, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" },
  agentOpenOff: { opacity: 0.35 },
  agentOpenText: { color: colors.bg, fontSize: 16, fontWeight: "600" },
  cardTitle: { color: colors.text, fontWeight: "700", fontSize: 15 },
  cardLine: { color: colors.text, fontSize: 14, lineHeight: 20 },
  barRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  bar: { height: 10, borderRadius: 5, backgroundColor: colors.link },
  barValue: { color: colors.muted, fontSize: 12, width: 40 },
  handoverDetail: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  handoverBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 6,
    borderRadius: 10,
    paddingVertical: 12,
    backgroundColor: colors.link,
  },
  handoverBtnDisabled: { opacity: 0.45 },
  handoverBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  approvalRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  approvalStatus: { color: colors.muted, fontSize: 14, fontWeight: "600", marginTop: 2 },
  choice: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  allow: { backgroundColor: "#1d5c2e" },
  deny: { backgroundColor: "#6e2b2b" },
  choiceText: { color: "#fff", fontWeight: "700" },
  pollCard: { backgroundColor: colors.bubble, borderRadius: 20, padding: 12, gap: 10 },
  pollHead: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8 },
  pollTitle: { color: colors.text, fontSize: 16, fontWeight: "600", lineHeight: 21, flex: 1, paddingHorizontal: 2, paddingTop: 2 },
  pollX: { width: 24, height: 24, alignItems: "center", justifyContent: "center", opacity: 0.5 },
  pollDesc: { color: colors.muted, fontSize: 15, lineHeight: 21 },
  // One inset list, rows split by hairlines.
  pollOptions: {
    backgroundColor: colors.bg,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    overflow: "hidden",
  },
  pollRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, paddingVertical: 10, minHeight: 48 },
  pollRowOn: { backgroundColor: colors.control },
  pollRowPressed: { backgroundColor: colors.control },
  pollDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  pollLetter: { width: 26, height: 26, borderRadius: 7, backgroundColor: colors.control, alignItems: "center", justifyContent: "center" },
  pollLetterOn: { backgroundColor: colors.link },
  pollLetterText: { color: colors.muted, fontSize: 13, fontWeight: "600" },
  pollLetterTextOn: { color: "#fff" },
  pollLabel: { color: colors.text, fontSize: 16, lineHeight: 21, flex: 1 },
  // No flex here: inside the column beside the badge it would collapse the
  // text's height and cut long labels off.
  questionLabel: { color: colors.text, fontSize: 16, lineHeight: 21 },
  pollDanger: { color: colors.danger },
  pollHint: { color: colors.muted, fontSize: 13, paddingHorizontal: 2 },
  pollSubmit: { height: 46, borderRadius: 14, backgroundColor: colors.control, alignItems: "center", justifyContent: "center" },
  pollSubmitReady: { backgroundColor: colors.text },
  pollSubmitText: { color: colors.muted, fontSize: 16, fontWeight: "600" },
  pollSubmitTextReady: { color: colors.bg },
  questionRowText: { flex: 1, gap: 2 },
  questionRowDone: { opacity: 0.4 },
  questionPrimaryLabel: { fontWeight: "600" },
  questionDescription: { color: colors.muted, fontSize: 14, lineHeight: 18 },
  questionCustom: {
    flex: 1,
    backgroundColor: colors.bg,
    color: colors.text,
    borderRadius: 14,
    height: 48,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  dismissed: { color: colors.muted, fontSize: 14 },
  tableHead: { flexDirection: "row", paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  tableHeader: { color: colors.text, fontSize: 14, fontWeight: "700" },
  tableRow: { flexDirection: "row", paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  tableCell: { color: colors.text, fontSize: 14 },
  tableCol: { minWidth: 128, maxWidth: 240, flexShrink: 0, paddingRight: 12 },
  tableNote: { color: colors.text, fontSize: 16, lineHeight: 24, marginTop: 8 },
  secretRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  secretStack: { gap: 8 },
  secretInput: {
    alignSelf: "stretch",
    backgroundColor: colors.bg,
    color: colors.text,
    borderRadius: 12,
    height: 48,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  secretSave: { height: 48, borderRadius: 24, backgroundColor: colors.control, alignItems: "center", justifyContent: "center", paddingHorizontal: 18 },
  secretSaveWide: { alignSelf: "stretch", borderRadius: 12 },
  secretSaveReady: { backgroundColor: colors.text },
  secretSaveText: { color: colors.muted, fontSize: 16, fontWeight: "600" },
  secretSaveTextReady: { color: colors.bg },
  secretFoot: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  secretFootText: { color: colors.muted, fontSize: 13, flex: 1 },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
