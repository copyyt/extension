import assert from "node:assert/strict";
import test from "node:test";
import {
  CONNECTIVITY_RECOVERY_ALARM_NAME,
  CONNECTIVITY_RECOVERY_PERIOD_MS,
  RESUME_DETECTION_THRESHOLD_MS,
  isLateConnectivityRecoveryAlarm,
} from "./connectivity-recovery.ts";

test("a normally delivered recovery alarm is not treated as resume", () => {
  const scheduledTime = 1_000_000;
  assert.equal(
    isLateConnectivityRecoveryAlarm(
      { name: CONNECTIVITY_RECOVERY_ALARM_NAME, scheduledTime },
      scheduledTime + CONNECTIVITY_RECOVERY_PERIOD_MS + 5_000,
    ),
    false,
  );
});

test("a substantially late recovery alarm is treated as sleep/wake resume", () => {
  const scheduledTime = 1_000_000;
  assert.equal(
    isLateConnectivityRecoveryAlarm(
      { name: CONNECTIVITY_RECOVERY_ALARM_NAME, scheduledTime },
      scheduledTime + RESUME_DETECTION_THRESHOLD_MS,
    ),
    true,
  );
  assert.equal(
    isLateConnectivityRecoveryAlarm(
      { name: "another-extension-alarm", scheduledTime },
      scheduledTime + RESUME_DETECTION_THRESHOLD_MS,
    ),
    false,
  );
});
