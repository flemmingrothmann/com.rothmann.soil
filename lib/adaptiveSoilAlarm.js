'use strict';

const STATES = {
  NORMAL: 'NORMAL',
  ALARM_AGGRESSIVE: 'ALARM_AGGRESSIVE',
  ALARM_MEDIUM: 'ALARM_MEDIUM',
  ALARM_BACKOFF: 'ALARM_BACKOFF',
  RECOVERY_AGGRESSIVE: 'RECOVERY_AGGRESSIVE',
  RECOVERY_MEDIUM: 'RECOVERY_MEDIUM',
};

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function asFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveAdaptiveAlarmConfig({ alarmThreshold, pollInterval }) {
  const lower = asFiniteNumber(alarmThreshold);
  const normalizedPollInterval = clampNumber(Math.round(asFiniteNumber(pollInterval) || 600), 1, 65535);

  if (lower === null || lower <= 0) {
    return {
      enabled: false,
      lower: 0,
      upper: 0,
      hysteresis: 0,
      significantRise: 0,
      normalInterval: normalizedPollInterval,
      aggressiveInterval: normalizedPollInterval,
      mediumInterval: normalizedPollInterval,
      aggressiveDurationMs: 0,
      mediumDurationMs: 0,
      recoveryAggressiveDurationMs: 0,
      recoveryMediumDurationMs: 0,
    };
  }

  const normalizedLower = clampNumber(Math.round(lower), 0, 100);
  const hysteresis = Math.min(12, Math.max(5, normalizedLower * 0.15));

  return {
    enabled: true,
    lower: normalizedLower,
    upper: Math.min(95, normalizedLower + hysteresis),
    hysteresis,
    significantRise: Math.max(3, hysteresis / 2),
    normalInterval: normalizedPollInterval,
    aggressiveInterval: Math.max(30, Math.min(60, Math.round(normalizedPollInterval / 10))),
    mediumInterval: Math.max(120, Math.min(300, Math.round(normalizedPollInterval / 3))),
    aggressiveDurationMs: Math.max(10 * 60 * 1000, Math.min(20 * 60 * 1000, normalizedPollInterval * 2 * 1000)),
    mediumDurationMs: 60 * 60 * 1000,
    recoveryAggressiveDurationMs: 10 * 60 * 1000,
    recoveryMediumDurationMs: 30 * 60 * 1000,
  };
}

function isKnownState(state) {
  return Object.values(STATES).includes(state);
}

function getStateInterval(state, config) {
  switch (state) {
    case STATES.ALARM_AGGRESSIVE:
    case STATES.RECOVERY_AGGRESSIVE:
      return config.aggressiveInterval;
    case STATES.ALARM_MEDIUM:
    case STATES.RECOVERY_MEDIUM:
      return config.mediumInterval;
    case STATES.NORMAL:
    case STATES.ALARM_BACKOFF:
    default:
      return config.normalInterval;
  }
}

function recoverState({ moisture, currentAlarm, config }) {
  if (!config.enabled) {
    return {
      state: STATES.NORMAL,
      alarmActive: false,
    };
  }

  const currentMoisture = asFiniteNumber(moisture);
  const alarmActive = currentAlarm === true;

  if (currentMoisture !== null) {
    if (currentMoisture <= config.lower) {
      return {
        state: STATES.ALARM_AGGRESSIVE,
        alarmActive: true,
      };
    }

    if (currentMoisture >= config.upper) {
      return {
        state: STATES.NORMAL,
        alarmActive: false,
      };
    }
  }

  if (alarmActive) {
    return {
      state: STATES.ALARM_AGGRESSIVE,
      alarmActive: true,
    };
  }

  return {
    state: STATES.NORMAL,
    alarmActive: false,
  };
}

function reconcileAdaptiveAlarm({
  currentState,
  stateStartedAt,
  previousMoisture,
  currentMoisture,
  currentAlarm,
  now,
  config,
}) {
  const timestamp = asFiniteNumber(now) || Date.now();
  const moisture = asFiniteNumber(currentMoisture);
  const priorMoisture = asFiniteNumber(previousMoisture);
  const recovered = !isKnownState(currentState)
    ? recoverState({ moisture, currentAlarm, config })
    : {
      state: currentState,
      alarmActive: currentAlarm === true,
    };

  let { state, alarmActive } = recovered;
  let startedAt = asFiniteNumber(stateStartedAt) ?? timestamp;
  let transitioned = false;

  if (!config.enabled) {
    return {
      previousState: currentState,
      state: STATES.NORMAL,
      stateStartedAt: timestamp,
      previousMoisture: moisture,
      alarmActive: false,
      reportInterval: config.normalInterval,
      lower: config.lower,
      upper: config.upper,
      transitioned: currentState !== STATES.NORMAL || currentAlarm === true,
    };
  }

  const transitionTo = (nextState, nextAlarmActive) => {
    if (state === nextState && alarmActive === nextAlarmActive) {
      return false;
    }

    state = nextState;
    alarmActive = nextAlarmActive;
    startedAt = timestamp;
    transitioned = true;
    return true;
  };

  let keepEvaluating = true;
  let guard = 0;

  while (keepEvaluating && guard < 8) {
    guard += 1;
    keepEvaluating = false;

    if (moisture !== null) {
      if (state === STATES.NORMAL && moisture <= config.lower) {
        keepEvaluating = transitionTo(STATES.ALARM_AGGRESSIVE, true);
        continue;
      }

      if ([STATES.ALARM_AGGRESSIVE, STATES.ALARM_MEDIUM, STATES.ALARM_BACKOFF].includes(state) && moisture >= config.upper) {
        keepEvaluating = transitionTo(STATES.RECOVERY_AGGRESSIVE, false);
        continue;
      }

      if ([STATES.RECOVERY_AGGRESSIVE, STATES.RECOVERY_MEDIUM].includes(state) && moisture <= config.lower) {
        keepEvaluating = transitionTo(STATES.ALARM_AGGRESSIVE, true);
        continue;
      }

      if (
        state === STATES.ALARM_BACKOFF
        && priorMoisture !== null
        && moisture < config.upper
        && moisture - priorMoisture >= config.significantRise
      ) {
        keepEvaluating = transitionTo(STATES.ALARM_AGGRESSIVE, true);
        continue;
      }
    }

    const elapsedMs = timestamp - startedAt;
    if (state === STATES.ALARM_AGGRESSIVE && elapsedMs >= config.aggressiveDurationMs) {
      keepEvaluating = transitionTo(STATES.ALARM_MEDIUM, true);
      continue;
    }

    if (state === STATES.ALARM_MEDIUM && elapsedMs >= config.mediumDurationMs) {
      keepEvaluating = transitionTo(STATES.ALARM_BACKOFF, true);
      continue;
    }

    if (state === STATES.RECOVERY_AGGRESSIVE && elapsedMs >= config.recoveryAggressiveDurationMs) {
      keepEvaluating = transitionTo(STATES.RECOVERY_MEDIUM, false);
      continue;
    }

    if (state === STATES.RECOVERY_MEDIUM && elapsedMs >= config.recoveryMediumDurationMs) {
      keepEvaluating = transitionTo(STATES.NORMAL, false);
    }
  }

  if (state === STATES.NORMAL) {
    alarmActive = false;
  } else if ([STATES.ALARM_AGGRESSIVE, STATES.ALARM_MEDIUM, STATES.ALARM_BACKOFF].includes(state)) {
    alarmActive = true;
  } else {
    alarmActive = false;
  }

  return {
    previousState: currentState,
    state,
    stateStartedAt: startedAt,
    previousMoisture: moisture,
    alarmActive,
    reportInterval: getStateInterval(state, config),
    lower: config.lower,
    upper: config.upper,
    transitioned,
  };
}

module.exports = {
  STATES,
  deriveAdaptiveAlarmConfig,
  reconcileAdaptiveAlarm,
};
