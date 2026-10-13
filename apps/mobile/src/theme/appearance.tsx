import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Appearance, useColorScheme } from "react-native";
import * as SecureStore from "../store";
import { darkColors, lightColors, setActivePalette } from "./tokens";

export type AppearanceChoice = "dark" | "light" | "system";

const KEY = "nano.appearance";

const AppearanceContext = createContext<{
  choice: AppearanceChoice;
  setChoice: (choice: AppearanceChoice) => void;
}>({
  choice: "dark",
  setChoice: () => {},
});

function paletteFor(choice: AppearanceChoice, system: string | null | undefined) {
  if (choice === "light") return lightColors;
  if (choice === "dark") return darkColors;
  return system === "light" ? lightColors : darkColors;
}

function applyChoice(choice: AppearanceChoice): void {
  if (typeof Appearance.setColorScheme === "function") {
    Appearance.setColorScheme(choice === "system" ? "unspecified" : choice);
  }
  const system = typeof Appearance.getColorScheme === "function" ? Appearance.getColorScheme() : null;
  setActivePalette(paletteFor(choice, system));
}

export async function readAppearance(): Promise<AppearanceChoice> {
  const stored = await SecureStore.getItemAsync(KEY);
  if (stored === "dark" || stored === "light" || stored === "system") return stored;
  return "dark";
}

/**
 * Remembers Dark, Light, or System and applies it to the app color scheme.
 */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<AppearanceChoice>(() => {
    applyChoice("dark");
    return "dark";
  });

  useEffect(() => {
    void readAppearance().then((stored) => {
      setChoiceState(stored);
      applyChoice(stored);
    });
  }, []);

  const setChoice = useCallback((next: AppearanceChoice) => {
    setChoiceState(next);
    applyChoice(next);
    void SecureStore.setItemAsync(KEY, next);
  }, []);

  return <AppearanceContext.Provider value={{ choice, setChoice }}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): { choice: AppearanceChoice; setChoice: (choice: AppearanceChoice) => void } {
  return useContext(AppearanceContext);
}

/** The scheme currently on screen, from the menu choice rather than a stale native hook. */
export function useResolvedScheme(): "light" | "dark" {
  const { choice } = useAppearance();
  const system = useColorScheme();
  if (choice === "light") return "light";
  if (choice === "dark") return "dark";
  return system === "light" ? "light" : "dark";
}
