'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');

const { STATES, deriveAdaptiveAlarmConfig, reconcileAdaptiveAlarm } = require('../../lib/adaptiveSoilAlarm');

class SoilMoistureSensorDevice extends ZigBeeDevice {

  static SOIL_WARNING_DEFAULT = 30;
  static ADAPTIVE_ALARM_STORE_KEY = 'adaptive_alarm';

  zclNode = null;
  pendingSettingsApply = false;
  lastWakeHandledAt = 0;

  async onNodeInit({ zclNode }) {
    try {
      this.log('Third Reality soil moisture sensor initialized');
      this.zclNode = zclNode;

      if (!this.hasCapability('measure_soil_moisture')) {
        await this.addCapability('measure_soil_moisture').catch(() => null);
      }
      if (!this.hasCapability('soil_warning_threshold')) {
        await this.addCapability('soil_warning_threshold').catch(() => null);
      }
      if (this.hasCapability('soil_warning_level')) {
        await this.removeCapability('soil_warning_level').catch(() => null);
      }
      if (this.hasCapability('target_soil_moisture')) {
        await this.removeCapability('target_soil_moisture').catch(() => null);
      }
      if (this.hasCapability('measure_moisture')) {
        await this.removeCapability('measure_moisture').catch(() => null);
      }
      if (this.hasCapability('measure_humidity')) {
        await this.removeCapability('measure_humidity').catch(() => null);
      }
      if (!this.hasCapability('alarm_water')) {
        await this.addCapability('alarm_water').catch(() => null);
      }

      await this.syncSoilWarningThreshold(this.getSoilWarningThreshold());
      await this.restoreAdaptiveAlarmState();

      await this.registerCapability('measure_battery', CLUSTER.POWER_CONFIGURATION);

      this.zclNode.endpoints[1].clusters[CLUSTER.TEMPERATURE_MEASUREMENT.NAME]
        .on('attr.measuredValue', this.onTemperatureMeasuredAttributeReport.bind(this));

      this.zclNode.endpoints[1].clusters[CLUSTER.POWER_CONFIGURATION.NAME]
        .on('attr.batteryPercentageRemaining', this.onBatteryPercentageRemainingAttributeReport.bind(this));

      this.zclNode.endpoints[1].clusters[CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT.NAME]
        .on('attr.measuredValue', this.onRelativeHumidityMeasuredAttributeReport.bind(this));

      if (this.isDeviceSleepy()) {
        this.log('Device is sleepy - reporting changes will be applied on next wake-up/report');
      }
    } catch (error) {
      this.error(error);
    }
  }

  onTemperatureMeasuredAttributeReport(measuredValue) {
    this.onDeviceAwake('temperature report').catch(this.error);

    const temperatureOffset = this.getSetting('temperature_offset') || 0;
    const parsedValue = this.getSetting('temperature_decimals') === '2'
      ? Math.round((measuredValue / 100) * 100) / 100
      : Math.round((measuredValue / 100) * 10) / 10;

    this.log('measure_temperature:', parsedValue, '+ offset', temperatureOffset);
    this.setCapabilityValue('measure_temperature', parsedValue + temperatureOffset).catch(this.error);
  }

  onRelativeHumidityMeasuredAttributeReport(measuredValue) {
    this.onDeviceAwake('humidity report').catch(this.error);

    const humidityOffset = this.getSetting('humidity_offset') || 0;
    const parsedValue = this.getSetting('humidity_decimals') === '2'
      ? Math.round((measuredValue / 100) * 100) / 100
      : Math.round((measuredValue / 100) * 10) / 10;

    const soilMoisture = parsedValue + humidityOffset;

    this.log('measure_soil_moisture:', parsedValue, '+ offset', humidityOffset);
    this.setCapabilityValue('measure_soil_moisture', soilMoisture).catch(this.error);
    this.handleAdaptiveAlarm(soilMoisture, 'humidity report').catch(this.error);
  }

  onBatteryPercentageRemainingAttributeReport(batteryPercentageRemaining) {
    this.onDeviceAwake('battery report').catch(this.error);

    this.log('measure_battery:', batteryPercentageRemaining / 2);
    this.setCapabilityValue('measure_battery', batteryPercentageRemaining / 2).catch(this.error);
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('soil_warning')) {
      this.syncSoilWarningThreshold(newSettings.soil_warning).catch(this.error);
      const soilMoisture = this.getCapabilityValue('measure_soil_moisture');
      if (typeof soilMoisture === 'number') {
        this.handleAdaptiveAlarm(soilMoisture, 'soil warning setting', false, !this.isDeviceSleepy()).catch(this.error);
      }
    }

    if (changedKeys.includes('humidity_report_max_interval')) {
      const soilMoisture = this.getCapabilityValue('measure_soil_moisture');
      if (typeof soilMoisture === 'number') {
        this.handleAdaptiveAlarm(soilMoisture, 'poll interval setting', true, !this.isDeviceSleepy()).catch(this.error);
      }
    }

    const reportingKeys = changedKeys.filter((key) => [
      'temperature_report_min_interval',
      'temperature_report_max_interval',
      'temperature_report_change',
      'humidity_report_min_interval',
      'humidity_report_max_interval',
      'humidity_report_change',
    ].includes(key));

    if (reportingKeys.length === 0) {
      return;
    }

    if (this.isDeviceSleepy()) {
      this.pendingSettingsApply = true;
      this.log('Device is sleepy - queueing reporting settings for next wake-up/report', reportingKeys);
      return;
    }

    await this.setTemperatureAndHumidityConfigReport(oldSettings, newSettings, reportingKeys);
    this.log('Third Reality soil moisture settings changed');
  }

  async onEndDeviceAnnounce() {
    await this.onDeviceAwake('announce');
  }

  async setTemperatureAndHumidityConfigReport(oldSettings, newSettings, changedKeys) {
    const temperatureReportMinInterval = changedKeys.includes('temperature_report_min_interval')
      ? newSettings.temperature_report_min_interval
      : oldSettings.temperature_report_min_interval;
    const temperatureReportMaxInterval = changedKeys.includes('temperature_report_max_interval')
      ? newSettings.temperature_report_max_interval
      : oldSettings.temperature_report_max_interval;
    const temperatureReportChange = changedKeys.includes('temperature_report_change')
      ? newSettings.temperature_report_change
      : oldSettings.temperature_report_change;
    const humidityReportMinInterval = changedKeys.includes('humidity_report_min_interval')
      ? newSettings.humidity_report_min_interval
      : oldSettings.humidity_report_min_interval;
    const humidityReportMaxInterval = changedKeys.includes('humidity_report_max_interval')
      ? newSettings.humidity_report_max_interval
      : oldSettings.humidity_report_max_interval;
    const humidityReportChange = changedKeys.includes('humidity_report_change')
      ? newSettings.humidity_report_change
      : oldSettings.humidity_report_change;

    if (temperatureReportMinInterval > temperatureReportMaxInterval || humidityReportMinInterval > humidityReportMaxInterval) {
      throw new Error('The minimum interval must be smaller than the maximum interval');
    }

    if (changedKeys.includes('temperature_report_min_interval') || changedKeys.includes('temperature_report_max_interval') || changedKeys.includes('temperature_report_change')) {
      await this.zclNode.endpoints[1].clusters.temperatureMeasurement.configureReporting({
        measuredValue: {
          minInterval: temperatureReportMinInterval,
          maxInterval: temperatureReportMaxInterval,
          minChange: temperatureReportChange,
        },
      });
    }

    if (changedKeys.includes('humidity_report_min_interval') || changedKeys.includes('humidity_report_max_interval') || changedKeys.includes('humidity_report_change')) {
      await this.zclNode.endpoints[1].clusters.relativeHumidity.configureReporting({
        measuredValue: {
          minInterval: humidityReportMinInterval,
          maxInterval: humidityReportMaxInterval,
          minChange: humidityReportChange,
        },
      });
    }
  }

  isDeviceSleepy() {
    return this.node?.receiveWhenIdle === false;
  }

  async onDeviceAwake(reason) {
    const store = this.getAdaptiveAlarmStore();
    const hasPendingAdaptiveApply = store.pending_adaptive_apply === true;

    if (!this.pendingSettingsApply && !hasPendingAdaptiveApply) {
      return;
    }

    const now = Date.now();
    const debounceMs = 5000;

    if (now - this.lastWakeHandledAt < debounceMs) {
      return;
    }

    this.lastWakeHandledAt = now;
    this.log(`Applying pending reporting settings after ${reason}`);

    if (this.pendingSettingsApply) {
      await this.setTemperatureAndHumidityConfigReport(this.getSettings(), this.getSettings(), [
        'temperature_report_min_interval',
        'temperature_report_max_interval',
        'temperature_report_change',
        'humidity_report_min_interval',
        'humidity_report_max_interval',
        'humidity_report_change',
      ]);
    }

    const soilMoisture = this.getCapabilityValue('measure_soil_moisture');
    if (typeof soilMoisture === 'number') {
      await this.handleAdaptiveAlarm(soilMoisture, `wake:${reason}`, true, true);
    }

    this.pendingSettingsApply = false;
    this.log('Third Reality soil moisture settings changed');
  }

  getSoilWarningThreshold() {
    return this.normalizeSoilWarningThreshold(this.getSetting('soil_warning'));
  }

  normalizeSoilWarningThreshold(value) {
    const parsedValue = Number(value);

    if (!Number.isFinite(parsedValue)) {
      return SoilMoistureSensorDevice.SOIL_WARNING_DEFAULT;
    }

    return Math.max(0, Math.min(100, Math.round(parsedValue)));
  }

  async syncSoilWarningThreshold(value) {
    if (!this.hasCapability('soil_warning_threshold')) {
      return;
    }

    const threshold = this.normalizeSoilWarningThreshold(value);

    await this.setCapabilityValue('soil_warning_threshold', threshold).catch(this.error);
  }

  getNormalPollInterval() {
    const pollInterval = Number(this.getSetting('humidity_report_max_interval'));
    return Number.isFinite(pollInterval) ? Math.max(1, Math.round(pollInterval)) : 300;
  }

  getAdaptiveAlarmConfig() {
    return deriveAdaptiveAlarmConfig({
      alarmThreshold: this.getSoilWarningThreshold(),
      pollInterval: this.getNormalPollInterval(),
    });
  }

  async restoreAdaptiveAlarmState() {
    const soilMoisture = this.getCapabilityValue('measure_soil_moisture');
    if (typeof soilMoisture !== 'number') {
      return;
    }

    await this.handleAdaptiveAlarm(soilMoisture, 'init', false, !this.isDeviceSleepy());
  }

  getAdaptiveAlarmStore() {
    return this.getStoreValue(SoilMoistureSensorDevice.ADAPTIVE_ALARM_STORE_KEY) || {};
  }

  async setAdaptiveAlarmStore(store) {
    await this.setStoreValue(SoilMoistureSensorDevice.ADAPTIVE_ALARM_STORE_KEY, store);
  }

  async handleAdaptiveAlarm(soilMoisture, reason, forceIntervalApply = false, allowIntervalApply = true) {
    const config = this.getAdaptiveAlarmConfig();
    const store = this.getAdaptiveAlarmStore();
    const currentAlarm = this.getCapabilityValue('alarm_water') === true;
    const next = reconcileAdaptiveAlarm({
      currentState: store.current_state,
      stateStartedAt: store.state_started_at,
      previousMoisture: store.previous_moisture,
      currentMoisture: soilMoisture,
      currentAlarm,
      now: Date.now(),
      config,
    });

    const lastReportInterval = Number.isFinite(store.last_report_interval) ? store.last_report_interval : null;
    const intervalNeedsApply = forceIntervalApply || lastReportInterval !== next.reportInterval;
    const activationNeedsInterval = !currentAlarm
      && next.alarmActive === true
      && next.state === STATES.ALARM_AGGRESSIVE
      && intervalNeedsApply;

    if (activationNeedsInterval && !allowIntervalApply) {
      await this.setAdaptiveAlarmStore({
        current_state: store.current_state || STATES.NORMAL,
        state_started_at: store.state_started_at || Date.now(),
        previous_moisture: soilMoisture,
        last_report_interval: lastReportInterval,
        pending_adaptive_apply: true,
      });

      this.log(
        `Deferring alarm activation until aggressive interval can be applied; moisture=${soilMoisture}, `
        + `lower=${next.lower}, upper=${next.upper}, target_interval=${next.reportInterval}`,
      );
      return;
    }

    if (allowIntervalApply && intervalNeedsApply) {
      await this.applyAdaptiveReportInterval(next.reportInterval, config);
    }

    if (next.alarmActive !== currentAlarm) {
      await this.setCapabilityValue('alarm_water', next.alarmActive).catch(this.error);
      if (next.alarmActive) {
        this.log(`Activated deferred dry-soil alarm after interval apply; moisture=${soilMoisture}, report_interval=${next.reportInterval}`);
      }
    }

    if (next.transitioned || forceIntervalApply || intervalNeedsApply) {
      this.log(
        `Adaptive alarm transition (${reason}) ${store.current_state || 'UNKNOWN'} -> ${next.state}; `
        + `moisture=${soilMoisture}, lower=${next.lower}, upper=${next.upper}, report_interval=${next.reportInterval}`,
      );
    }

    await this.setAdaptiveAlarmStore({
      current_state: next.state,
      state_started_at: next.stateStartedAt,
      previous_moisture: next.previousMoisture,
      last_report_interval: next.reportInterval,
      pending_adaptive_apply: false,
    });
  }

  async applyAdaptiveReportInterval(reportInterval, config) {
    if (!this.zclNode?.endpoints?.[1]?.clusters?.relativeHumidity) {
      return;
    }

    const normalMinInterval = Number(this.getSetting('humidity_report_min_interval')) || config.normalInterval;
    const reportChange = Number(this.getSetting('humidity_report_change')) || 0;
    const isNormalInterval = reportInterval === config.normalInterval;

    await this.zclNode.endpoints[1].clusters.relativeHumidity.configureReporting({
      measuredValue: {
        minInterval: isNormalInterval ? normalMinInterval : reportInterval,
        maxInterval: reportInterval,
        minChange: reportChange,
      },
    });
  }

}

module.exports = SoilMoistureSensorDevice;
