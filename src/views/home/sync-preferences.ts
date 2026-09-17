import type { RuntimeStatus } from "../../runtime/messages.ts";
import {
  DEFAULT_SYNC_PREFERENCES,
  type SyncPreferences,
} from "../../runtime/sync-preferences.ts";

export type ClipboardSyncMode = "both" | "send-only" | "receive-only" | "off";

export function syncPreferencesForStatus(
  status: Pick<RuntimeStatus, "syncPreferences"> | { syncPreferences?: SyncPreferences } | null | undefined,
): SyncPreferences {
  return status?.syncPreferences ?? DEFAULT_SYNC_PREFERENCES;
}

export function clipboardSyncMode(preferences: SyncPreferences): ClipboardSyncMode {
  if (preferences.sendEnabled && preferences.receiveEnabled) return "both";
  if (preferences.sendEnabled) return "send-only";
  if (preferences.receiveEnabled) return "receive-only";
  return "off";
}
