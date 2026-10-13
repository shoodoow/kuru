import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import type { ComponentProps } from "react";
import type { ColorValue } from "react-native";
import { colors } from "../theme/tokens";

type MaterialName = ComponentProps<typeof MaterialIcons>["name"];

/**
 * Draws one icon in the platform's own set.
 * iOS uses an SF Symbol. Android uses a Material icon. Web uses Material too.
 */
function PlatformIcon({
  sf,
  md,
  size,
  color,
}: {
  sf: SymbolViewProps["name"];
  md: MaterialName;
  size: number;
  color: ColorValue;
}) {
  if (process.env.EXPO_OS === "ios") {
    return <SymbolView name={sf} tintColor={color} size={size} />;
  }
  return <MaterialIcons name={md} size={size} color={color as string} />;
}

export function IconSearch() {
  return <PlatformIcon sf="magnifyingglass" md="search" size={18} color={colors.label} />;
}

export function IconPlus() {
  return <PlatformIcon sf="plus" md="add" size={18} color={colors.label} />;
}

export function IconBack() {
  return <PlatformIcon sf="chevron.left" md="arrow-back" size={22} color={colors.label} />;
}

export function IconMonitor() {
  return <PlatformIcon sf="desktopcomputer" md="desktop-windows" size={18} color={colors.label} />;
}

export function IconMic() {
  return <PlatformIcon sf="mic" md="mic" size={18} color={colors.label} />;
}

export function IconWave() {
  return <PlatformIcon sf="waveform" md="graphic-eq" size={18} color={colors.label} />;
}

export function IconHelp() {
  return <PlatformIcon sf="questionmark.circle" md="help-outline" size={18} color={colors.label} />;
}

export function IconMore() {
  return <PlatformIcon sf="ellipsis" md="more-horiz" size={18} color={colors.label} />;
}

export function IconClipboard() {
  return <PlatformIcon sf="list.clipboard" md="assignment" size={18} color={colors.label} />;
}

export function IconKeyboard() {
  return <PlatformIcon sf="keyboard" md="keyboard" size={20} color={colors.label} />;
}

export function IconClose() {
  return <PlatformIcon sf="xmark" md="close" size={18} color={colors.label} />;
}

export function IconChevron() {
  return <PlatformIcon sf="chevron.right" md="chevron-right" size={18} color={colors.secondaryLabel} />;
}

export function IconCheck() {
  return <PlatformIcon sf="checkmark" md="check" size={18} color={colors.label} />;
}

export function IconTrash() {
  return <PlatformIcon sf="trash" md="delete-outline" size={18} color={colors.danger} />;
}

export function IconReply() {
  return <PlatformIcon sf="arrowshape.turn.up.left" md="reply" size={16} color={colors.secondaryLabel} />;
}

export function IconShare() {
  return <PlatformIcon sf="square.and.arrow.up" md="share" size={20} color={colors.label} />;
}

export function IconDoc() {
  return <PlatformIcon sf="doc.text" md="description" size={20} color={colors.secondaryLabel} />;
}

export function IconClock() {
  return <PlatformIcon sf="clock" md="schedule" size={20} color={colors.green} />;
}

export function IconPin() {
  return <PlatformIcon sf="pin" md="push-pin" size={18} color={colors.label} />;
}

export function IconEyeOff() {
  return <PlatformIcon sf="eye.slash" md="visibility-off" size={18} color={colors.danger} />;
}

export function IconShield() {
  return <PlatformIcon sf="shield" md="shield" size={16} color={colors.secondaryLabel} />;
}

export function IconExpand() {
  return <PlatformIcon sf="arrow.up.left.and.arrow.down.right" md="open-in-full" size={15} color={colors.secondaryLabel} />;
}

export function IconCollapse() {
  return <PlatformIcon sf="arrow.down.right.and.arrow.up.left" md="close-fullscreen" size={18} color={colors.label} />;
}

export function IconCopy() {
  return <PlatformIcon sf="doc.on.doc" md="content-copy" size={18} color={colors.label} />;
}

export function IconSelectText() {
  return <PlatformIcon sf="text.cursor" md="text-fields" size={18} color={colors.label} />;
}

export function IconReplyAction() {
  return <PlatformIcon sf="arrowshape.turn.up.left" md="reply" size={18} color={colors.label} />;
}

export function IconGlobe() {
  return <PlatformIcon sf="globe" md="public" size={16} color={colors.secondaryLabel} />;
}

export function IconPlay() {
  return <PlatformIcon sf="play.fill" md="play-arrow" size={26} color="#FFFFFF" />;
}

export function IconCloseLight() {
  return <PlatformIcon sf="xmark" md="close" size={18} color="#FFFFFF" />;
}

export function IconDownload() {
  return <PlatformIcon sf="arrow.down.to.line" md="file-download" size={17} color={colors.label} />;
}

export function IconDownloadLight() {
  return <PlatformIcon sf="arrow.down.to.line" md="file-download" size={18} color="#FFFFFF" />;
}

/** The send glyph: an up arrow on iOS, a paper plane on Android, as in Telegram on each. */
export function IconSend({ color }: { color: ColorValue }) {
  return <PlatformIcon sf="arrow.up" md="send" size={process.env.EXPO_OS === "ios" ? 18 : 26} color={color} />;
}

export function IconToastDone() {
  return <PlatformIcon sf="checkmark.circle.fill" md="check-circle" size={20} color={colors.green} />;
}

export function IconToastWarn() {
  return <PlatformIcon sf="exclamationmark.circle.fill" md="error" size={20} color={colors.danger} />;
}

export function IconDismiss() {
  return <PlatformIcon sf="xmark" md="close" size={16} color={colors.secondaryLabel} />;
}
