import * as SecureStore from "../store";

const TRACKPAD_KEY = "nano.desktop.trackpad";

export async function getTrackpadMode(): Promise<boolean> {
  const value = await SecureStore.getItemAsync(TRACKPAD_KEY);
  return value === "1";
}

export async function setTrackpadMode(enabled: boolean): Promise<void> {
  await SecureStore.setItemAsync(TRACKPAD_KEY, enabled ? "1" : "0");
}
