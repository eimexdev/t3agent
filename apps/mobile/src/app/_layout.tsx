import "../../global.css";
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_700Bold,
  useFonts,
} from "@expo-google-fonts/dm-sans";
import { usePathname } from "expo-router";
import Stack from "expo-router/stack";
import { useCallback } from "react";
import { Platform, StatusBar, useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useResolveClassNames } from "uniwind";

import { LoadingScreen } from "../components/LoadingScreen";

import { useWorkspaceState } from "../state/workspace";
import { useThreadOutboxDrain } from "../state/use-thread-outbox-drain";
import { RegistryContext } from "@effect/atom-react";
import { appAtomRegistry } from "../state/atom-registry";
import { CloudAuthProvider } from "../features/cloud/CloudAuthProvider";
import {
  ClerkSettingsSheetDetentProvider,
  useClerkSettingsSheetDetent,
} from "../features/cloud/ClerkSettingsSheetDetent";
import { useAgentNotificationNavigation } from "../features/agent-awareness/notificationNavigation";
import { useHeaderBlurEffect } from "../lib/useHeaderBlurEffect";
import { useThemeColor } from "../lib/useThemeColor";

function AppNavigator() {
  const pathname = usePathname();
  const expandedSettingsRouteIsActive =
    pathname === "/settings/archive" || pathname === "/settings/auth";

  return (
    <ClerkSettingsSheetDetentProvider initiallyExpanded={expandedSettingsRouteIsActive}>
      <AppNavigatorContent />
    </ClerkSettingsSheetDetentProvider>
  );
}

function AppNavigatorContent() {
  const { state } = useWorkspaceState();
  const { collapse, isExpanded } = useClerkSettingsSheetDetent();
  const colorScheme = useColorScheme();
  const statusBarBg = useThemeColor("--color-status-bar");
  const screenColor = useThemeColor("--color-screen");
  const sheetStyle = useResolveClassNames("bg-sheet");
  const headerBlurEffect = useHeaderBlurEffect();
  useAgentNotificationNavigation();
  useThreadOutboxDrain();

  const handleSettingsTransitionEnd = useCallback(
    (event: { data: { closing: boolean } }) => {
      if (event.data.closing) {
        collapse();
      }
    },
    [collapse],
  );

  const newTaskScreenOptions = {
    contentStyle: sheetStyle,
    gestureEnabled: true,
    headerShown: false,
    presentation: "formSheet" as const,
    sheetAllowedDetents: [0.92],
    sheetGrabberVisible: true,
  };

  const connectionSheetScreenOptions = {
    contentStyle: sheetStyle,
    gestureEnabled: true,
    headerShown: false,
    presentation: "formSheet" as const,
    sheetAllowedDetents: [0.55, 0.7],
    sheetGrabberVisible: true,
  };

  const settingsSheetScreenOptions = {
    ...connectionSheetScreenOptions,
    sheetAllowedDetents: isExpanded ? [0.92] : [0.7],
  };

  if (state.isLoadingConnections) {
    return <LoadingScreen message="Loading remote workspace…" />;
  }

  return (
    <>
      <StatusBar
        barStyle={colorScheme === "dark" ? "light-content" : "dark-content"}
        backgroundColor={String(statusBarBg)}
        translucent
      />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen
          name="index"
          options={{
            contentStyle: { backgroundColor: String(screenColor) },
            headerShown: true,
            headerTransparent: true,
            headerBlurEffect,
            headerShadowVisible: false,
          }}
        />
        <Stack.Screen
          name="settings"
          listeners={{ transitionEnd: handleSettingsTransitionEnd }}
          options={settingsSheetScreenOptions}
        />
        <Stack.Screen name="connections" options={connectionSheetScreenOptions} />
        <Stack.Screen name="new" options={newTaskScreenOptions} />
        <Stack.Screen
          name="threads/[environmentId]/[threadId]"
          options={{
            // iOS keeps the default push animation: forcing slide_from_right
            // switches react-native-screens to its custom swipe animator,
            // which leaves a black void behind the screen during swipe-back.
            animation: Platform.OS === "ios" ? "default" : "slide_from_right",
            contentStyle: { backgroundColor: String(screenColor) },
            gestureEnabled: true,
            fullScreenGestureEnabled: true,
            headerShown: false,
          }}
        />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_700Bold,
  });
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <CloudAuthProvider>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <KeyboardProvider statusBarTranslucent>
            <SafeAreaProvider>
              {fontsLoaded ? (
                <AppNavigator />
              ) : (
                <LoadingScreen message="Loading remote workspace…" />
              )}
            </SafeAreaProvider>
          </KeyboardProvider>
        </GestureHandlerRootView>
      </CloudAuthProvider>
    </RegistryContext.Provider>
  );
}
