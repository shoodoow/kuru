import { Platform } from "react-native";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";

export const ANDROID_NOTIFICATION_CHANNEL = "default";

type NotificationsModule = typeof import("expo-notifications");

/** Importing expo-notifications on Android Expo Go throws at load time (SDK 53+). */
/** True inside the Expo Go app, which is for development and must never receive the account's pushes. */
export function isExpoGo(): boolean {
  return Constants.appOwnership === "expo" || Constants.executionEnvironment === "storeClient";
}

const INSTALL_ID_KEY = "kuru.install-id";

/**
 * A random id for this install of the app, kept on the phone.
 * Why: the server kept every token it was ever given, so a token from Expo Go
 * stayed next to the installed app's, and tapping its push opened Expo Go.
 * The install id lets the server keep one row per install and drop old ones.
 */
export function installId(): string {
  let id = SecureStore.getItem(INSTALL_ID_KEY);
  if (!id) {
    id = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join("-");
    SecureStore.setItem(INSTALL_ID_KEY, id);
  }
  return id;
}

export function isAndroidExpoGo(): boolean {
  return Platform.OS === "android" && Constants.appOwnership === "expo";
}

let notificationsCache: NotificationsModule | null | undefined;

async function loadNotifications(): Promise<NotificationsModule | null> {
  if (Platform.OS === "web" || isAndroidExpoGo()) return null;
  if (notificationsCache !== undefined) return notificationsCache;
  try {
    notificationsCache = await import("expo-notifications");
    return notificationsCache;
  } catch {
    notificationsCache = null;
    return null;
  }
}

/** Expo Go on Android cannot use remote push (SDK 53+). */
export function canUseRemotePush(): boolean {
  // Expo Go registered its own token, and a push to it opened Expo Go instead of the app.
  if (Platform.OS === "web" || isExpoGo()) return false;
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas
    ?.projectId;
  return Boolean(projectId);
}

async function ensureAndroidNotificationChannel(Notifications: NotificationsModule): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(ANDROID_NOTIFICATION_CHANNEL, {
    name: "Agent updates",
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 200, 120, 200],
  });
}

export async function ensureLocalNotificationsReady(): Promise<boolean> {
  try {
    const Notifications = await loadNotifications();
    if (!Notifications) return false;
    await ensureAndroidNotificationChannel(Notifications);
    const { status: existing } = await Notifications.getPermissionsAsync();
    const status =
      existing === "granted" ? existing : (await Notifications.requestPermissionsAsync()).status;
    return status === "granted";
  } catch {
    return false;
  }
}

export function localNotificationContent(input: {
  title: string;
  body: string;
  data: Record<string, unknown>;
}) {
  return {
    title: input.title,
    body: input.body,
    data: input.data,
    ...(Platform.OS === "android" ? { channelId: ANDROID_NOTIFICATION_CHANNEL } : {}),
  };
}

export async function scheduleLocalNotification(input: {
  title: string;
  body: string;
  data: Record<string, unknown>;
}): Promise<void> {
  const Notifications = await loadNotifications();
  if (!Notifications) return;
  if (!(await ensureLocalNotificationsReady())) return;
  await Notifications.scheduleNotificationAsync({
    content: localNotificationContent(input),
    trigger: null,
  });
}

export async function getPushToken(): Promise<{ token: string; platform: string; installId: string } | null> {
  try {
    if (!canUseRemotePush()) return null;
    const Notifications = await loadNotifications();
    if (!Notifications) return null;
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas
      ?.projectId;
    if (!projectId) return null;
    const { status: existing } = await Notifications.getPermissionsAsync();
    const status =
      existing === "granted" ? existing : (await Notifications.requestPermissionsAsync()).status;
    if (status !== "granted") return null;
    await ensureAndroidNotificationChannel(Notifications);
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    return { token: token.data, platform: Platform.OS, installId: installId() };
  } catch {
    return null;
  }
}

/** Launch taps already acted on, so remounting the listener does not open the chat again. */
const handledLaunchTaps = new Set<string>();

export function onPushTap(callback: (data: Record<string, unknown>) => void): () => void {
  if (isAndroidExpoGo()) return () => {};
  let remove = (): void => {};
  void loadNotifications().then((Notifications) => {
    if (!Notifications) return;
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, unknown> | undefined;
      if (data) callback(data);
    });
    remove = () => subscription.remove();
    // A tap that launched the app arrived before this listener existed: read it once.
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        const data = response?.notification.request.content.data as Record<string, unknown> | undefined;
        const id = response?.notification.request.identifier;
        if (!data || !id || handledLaunchTaps.has(id)) return;
        handledLaunchTaps.add(id);
        callback(data);
      })
      .catch(() => {});
  });
  return () => remove();
}

/** Calls back with each push that arrives while the app is open. */
export function onPushWhileOpen(callback: (content: { title: string; body: string; data: Record<string, unknown> }) => void): () => void {
  if (isAndroidExpoGo()) return () => {};
  let remove = (): void => {};
  void loadNotifications().then((Notifications) => {
    if (!Notifications) return;
    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      const content = notification.request.content;
      callback({ title: content.title ?? "", body: content.body ?? "", data: (content.data ?? {}) as Record<string, unknown> });
    });
    remove = () => subscription.remove();
  });
  return () => remove();
}

export function configureForegroundBanners(): void {
  if (isAndroidExpoGo()) return;
  void loadNotifications().then((Notifications) => {
    if (!Notifications) return;
    void ensureLocalNotificationsReady();
    try {
      // This runs only while the app is open. The person is already here, so
      // a push that lands now shows no banner and makes no sound; the app
      // shows its own note for other chats. Closed, the system shows it as usual.
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldPlaySound: false,
          shouldSetBadge: false,
          shouldShowBanner: false,
          shouldShowList: true,
          shouldShowAlert: false,
        }),
      });
    } catch {
      // Notifications unavailable.
    }
  });
}
