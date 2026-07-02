import Stack from "expo-router/stack";
import { Platform, StyleSheet } from "react-native";
import { useResolveClassNames } from "uniwind";

import { useHeaderBlurEffect } from "../../../../lib/useHeaderBlurEffect";

// iOS keeps the default push animation: forcing slide_from_right switches
// react-native-screens to its custom swipe animator, which paints a black
// void behind the outgoing screen during interactive swipe-back.
const pushAnimation = Platform.OS === "ios" ? ("default" as const) : ("slide_from_right" as const);

export default function ThreadLayout() {
  const headerBlurEffect = useHeaderBlurEffect();
  const sheetStyle = StyleSheet.flatten(useResolveClassNames("bg-sheet"));
  const headerBg = {
    backgroundColor: (sheetStyle as { backgroundColor?: string })?.backgroundColor,
  };

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen
        name="index"
        options={{
          contentStyle: { backgroundColor: "transparent" },
          headerShown: true,
          headerTransparent: true,
          headerBlurEffect,
          headerShadowVisible: false,
          headerTitle: "",
        }}
      />
      <Stack.Screen
        name="git"
        options={{
          contentStyle: sheetStyle,
          gestureEnabled: true,
          headerShown: false,
          presentation: "formSheet" as const,
          sheetAllowedDetents: [0.85],
          sheetGrabberVisible: true,
        }}
      />
      <Stack.Screen
        name="git-confirm"
        options={{
          contentStyle: sheetStyle,
          gestureEnabled: true,
          headerShown: false,
          presentation: "formSheet" as const,
          sheetAllowedDetents: [0.4],
          sheetGrabberVisible: true,
        }}
      />
      <Stack.Screen
        name="review"
        options={{
          animation: pushAnimation,
          contentStyle: sheetStyle,
          fullScreenGestureEnabled: true,
          headerBackButtonDisplayMode: "minimal",
          headerShown: true,
          headerTitle: "Files changed",
          headerBackTitle: "",
          headerShadowVisible: false,
          headerStyle: headerBg,
        }}
      />
      <Stack.Screen
        name="files/index"
        options={{
          animation: pushAnimation,
          contentStyle: sheetStyle,
          fullScreenGestureEnabled: true,
          headerBackButtonDisplayMode: "minimal",
          headerShown: true,
          headerTitle: "Files",
          headerBackTitle: "",
          headerShadowVisible: false,
          headerStyle: headerBg,
        }}
      />
      <Stack.Screen
        name="files/[...path]"
        options={{
          animation: pushAnimation,
          contentStyle: sheetStyle,
          fullScreenGestureEnabled: true,
          headerBackButtonDisplayMode: "minimal",
          headerShown: true,
          headerTitle: "File",
          headerBackTitle: "",
          headerShadowVisible: false,
          headerStyle: headerBg,
        }}
      />
      <Stack.Screen
        name="review-comment"
        options={{
          contentStyle: sheetStyle,
          gestureEnabled: true,
          headerShown: false,
          presentation: "formSheet" as const,
          sheetAllowedDetents: [0.72, 0.92],
          sheetGrabberVisible: true,
        }}
      />
      <Stack.Screen
        name="terminal"
        options={{
          animation: pushAnimation,
          contentStyle: { backgroundColor: "#050505" },
          headerBackButtonDisplayMode: "minimal",
          headerShown: true,
          headerShadowVisible: false,
        }}
      />
    </Stack>
  );
}
