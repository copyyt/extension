export const CONNECTIVITY_RECOVERY_ALARM_NAME =
  "copyyt-connectivity-recovery";
export const CONNECTIVITY_RECOVERY_PERIOD_MINUTES = 1;
export const CONNECTIVITY_RECOVERY_PERIOD_MS =
  CONNECTIVITY_RECOVERY_PERIOD_MINUTES * 60_000;

// A few seconds of alarm jitter is normal. Five minutes is deliberately
// conservative so a healthy socket is not recycled merely because Chrome's
// scheduler was busy.
export const RESUME_DETECTION_THRESHOLD_MS = 5 * 60_000;

export interface ConnectivityRecoveryAlarm {
  name: string;
  scheduledTime?: number;
}

export function isLateConnectivityRecoveryAlarm(
  alarm: ConnectivityRecoveryAlarm,
  now = Date.now(),
): boolean {
  return (
    alarm.name === CONNECTIVITY_RECOVERY_ALARM_NAME &&
    typeof alarm.scheduledTime === "number" &&
    Number.isFinite(alarm.scheduledTime) &&
    now - alarm.scheduledTime >= RESUME_DETECTION_THRESHOLD_MS
  );
}
