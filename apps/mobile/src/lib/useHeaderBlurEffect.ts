import { useColorScheme } from "react-native";

/**
 * Blur effect for transparent navigation headers.
 *
 * Recent iOS betas stopped drawing the implicit material behind transparent
 * navigation bars, and the trait-adaptive `systemChromeMaterial` resolves to
 * its light variant there even while the app renders in dark mode — so pick
 * the light/dark variant explicitly from the app color scheme.
 */
export function useHeaderBlurEffect() {
  return useColorScheme() === "dark"
    ? ("systemChromeMaterialDark" as const)
    : ("systemChromeMaterialLight" as const);
}
