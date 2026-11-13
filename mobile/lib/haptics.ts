import * as Haptics from "expo-haptics";

/** Light feedback on choosing; a success pulse only when the server has confirmed. Never throws. */
export const haptic = {
  select: () => void Haptics.selectionAsync().catch(() => {}),
  success: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}),
};
