import assert from "node:assert/strict";
import test from "node:test";
import {
  CONNECTIVITY_RECOVERY_ALARM_NAME,
  CONNECTIVITY_RECOVERY_PERIOD_MS,
  RESUME_DETECTION_THRESHOLD_MS,
  ensureConnectivityRecoveryAlarm,
  isLateConnectivityRecoveryAlarm,
} from "./connectivity-recovery.ts";

test("recovery alarm ensure does not replace an existing alarm", async () => {
  let getCalls = 0;
  let createCalls = 0;
  const alarms = {
    get: async () => {
      getCalls += 1;
      return { name: CONNECTIVITY_RECOVERY_ALARM_NAME };
    },
    create: async () => {
      createCalls += 1;
    },
  };

  await ensureConnectivityRecoveryAlarm(alarms);

  assert.equal(getCalls, 1);
  assert.equal(createCalls, 0);
});

test("recovery alarm ensure recreates a missing alarm", async () => {
  let created: { name: string; periodInMinutes: number } | undefined;
  const alarms = {
    get: async () => undefined,
    create: async (name: string, alarmInfo: { periodInMinutes: number }) => {
      created = { name, periodInMinutes: alarmInfo.periodInMinutes };
    },
  };

  await ensureConnectivityRecoveryAlarm(alarms);

  assert.deepEqual(created, {
    name: CONNECTIVITY_RECOVERY_ALARM_NAME,
    periodInMinutes: 1,
  });
});

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
