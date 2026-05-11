'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');

const { TUYA_CLUSTER_ID, TuyaDataTypes } = require('./TuyaCluster');
const { decodeTuyaDpValuesFromZclFrame } = require('./tuyaFrame');
const { STATES, deriveAdaptiveAlarmConfig, reconcileAdaptiveAlarm } = require('./adaptiveSoilAlarm');
const {
  clampPercent,
  rawTemperatureTimes10ToCelsius,
  clampSamplingSeconds,
  clampSoilWarning,
} = require('./tuyaSoilMath');

class TuyaSoilSensorDevice extends ZigBeeDevice {

  static ADAPTIVE_ALARM_STORE_KEY = 'adaptive_alarm';
  static CONFIG = null;

  tuyaCluster = null;
  pendingSettingsApply = false;
  endpoint1 = null;
  lastWakeHandledAt = 0;
  lastCapabilityValues = new Map();
  lastBatteryPercentage = null;

  getConfig() {
    return this.constructor.CONFIG;
  }

  async onNodeInit({ zclNode }) {
    const config = this.getConfig();
    this.log(`${config.logName} device initialized`);

    const endpoint = zclNode.endpoints[1];
    if (!endpoint) {
      this.error('Endpoint 1 not found');
      return;
    }

    this.endpoint1 = endpoint;

    for (const capability of config.requiredCapabilities) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability).catch(this.error);
      }
    }

    await this.registerPowerConfigurationBattery(endpoint).catch(this.error);

    this.syncSoilWarningThreshold(this.getSetting('soil_warning') ?? config.defaults.SOIL_WARNING_PERCENT).catch(this.error);

    const isSleepy = this.isDeviceSleepy();
    this.log(`Device is ${isSleepy ? 'sleepy (battery-powered)' : 'always-on'}`);

    const isFirstInit = typeof this.isFirstInit === 'function' ? this.isFirstInit() : false;
    if (isFirstInit) {
      this.log('First init - sending Tuya magic packet');
      await this.configureMagicPacket(zclNode).catch(this.error);
    }

    this.tuyaCluster = endpoint.clusters.tuya || endpoint.clusters[TUYA_CLUSTER_ID];
    if (!this.tuyaCluster) {
      try {
        await endpoint.bind('tuya');
        this.tuyaCluster = endpoint.clusters.tuya;
      } catch (error) {
        this.log('Could not bind Tuya cluster:', error);
      }
    }

    this.setupTuyaListeners();

    this.registerRawReportHandler(zclNode);

    if (isSleepy) {
      this.log('Device is sleepy - will apply settings and read battery when device wakes up');
    } else {
      if (this.tuyaCluster) {
        await this.applyDeviceSettings().catch(this.error);
      }
      await this.restoreAdaptiveAlarmState(true).catch(this.error);
      await this.readBattery(endpoint).catch(this.error);
    }
  }

  async applyDeviceSettings() {
    if (!this.tuyaCluster) {
      return;
    }

    const config = this.getConfig();
    const applied = {};

    for (const writer of config.settingWriters) {
      const rawValue = this.getSetting(writer.settingId);
      const value = writer.transform(rawValue ?? writer.defaultValue);
      applied[writer.settingId] = value;
      if (writer.enum) {
        await this.tuyaCluster.setDatapointEnum(writer.dp, value);
      } else {
        await this.tuyaCluster.setDatapointValue(writer.dp, value);
      }
    }

    this.log('Applied device settings', applied);
  }

  registerRawReportHandler(zclNode) {
    const endpoint = zclNode.endpoints[1];
    if (!endpoint) {
      return;
    }

    const originalHandleFrame = endpoint.handleFrame?.bind(endpoint);
    if (!originalHandleFrame) {
      return;
    }

    endpoint.handleFrame = (clusterId, frame, meta) => {
      if (clusterId === TUYA_CLUSTER_ID) {
        this.parseRawTuyaFrame(frame);
        this.onDeviceAwake('report').catch(this.error);
      }
      return originalHandleFrame(clusterId, frame, meta);
    };
  }

  setupTuyaListeners() {
    if (!this.tuyaCluster) {
      return;
    }

    this.tuyaCluster.on('reporting', (args) => {
      this.processTuyaReport(args);
    });

    this.tuyaCluster.on('response', (args) => {
      this.processTuyaReport(args);
    });

    this.tuyaCluster.on('datapoint', (args) => {
      this.processTuyaReport(args);
    });
  }

  processTuyaReport(args) {
    if (!args) {
      return;
    }

    const { dp, datatype, data } = args;
    if (typeof dp === 'number' && data) {
      this.processDataPoint(dp, datatype || 0, Buffer.isBuffer(data) ? data : Buffer.from([data]));
    }
  }

  parseRawTuyaFrame(frame) {
    try {
      const decoded = decodeTuyaDpValuesFromZclFrame(frame);
      for (const dpValue of decoded.dpValues) {
        this.processDataPoint(dpValue.dp, dpValue.datatype, dpValue.data);
      }
    } catch (error) {
      this.error('Error parsing raw Tuya frame:', error);
    }
  }

  parseDpValue(datatype, data) {
    switch (datatype) {
      case TuyaDataTypes.BOOL:
        return data.readUInt8(0) !== 0;
      case TuyaDataTypes.VALUE:
        if (data.length >= 4) return data.readInt32BE(0);
        if (data.length >= 2) return data.readInt16BE(0);
        return data.readUInt8(0);
      case TuyaDataTypes.ENUM:
        return data.readUInt8(0);
      default:
        if (data.length >= 4) return data.readInt32BE(0);
        if (data.length >= 2) return data.readUInt16BE(0);
        if (data.length >= 1) return data.readUInt8(0);
        throw new Error(`Unknown datatype ${datatype} or empty data`);
    }
  }

  processDataPoint(dp, datatype, data) {
    const config = this.getConfig();
    const mapping = config.dpHandlers[dp];
    if (!mapping) {
      this.log(`Unknown DP ${dp} (type: ${datatype})`);
      return;
    }

    const rawValue = this.parseDpValue(datatype, data);
    const value = mapping.divideBy && typeof rawValue === 'number' ? rawValue / mapping.divideBy : rawValue;

    switch (mapping.handler) {
      case 'temperature':
        if (typeof rawValue === 'number' && this.hasCapability('measure_temperature')) {
          this.updateCapabilityIfChanged('measure_temperature', rawTemperatureTimes10ToCelsius(rawValue)).catch(this.error);
        }
        break;
      case 'soilMoisture':
        if (typeof value === 'number') {
          const soilMoisture = clampPercent(value);
          if (this.hasCapability('measure_soil_moisture')) {
            this.updateCapabilityIfChanged('measure_soil_moisture', soilMoisture).catch(this.error);
          }
          if (this.hasCapability('alarm_water')) {
            this.handleAdaptiveAlarm(soilMoisture, 'soil moisture report').catch(this.error);
          }
        }
        break;
      case 'humidity':
        if (typeof value === 'number' && this.hasCapability('measure_humidity')) {
          this.updateCapabilityIfChanged('measure_humidity', clampPercent(value)).catch(this.error);
        }
        break;
      case 'illuminance':
        if (typeof value === 'number' && this.hasCapability('measure_luminance')) {
          this.updateCapabilityIfChanged('measure_luminance', value).catch(this.error);
        }
        break;
      case 'soilFertility':
        if (typeof value === 'number' && this.hasCapability('measure_soil_fertility')) {
          this.updateCapabilityIfChanged('measure_soil_fertility', value).catch(this.error);
        }
        break;
      case 'battery':
        if (typeof value === 'number' && this.hasCapability('measure_battery')) {
          this.updateBatteryCapability(clampPercent(value), 'tuya').catch(this.error);
        }
        break;
      case 'waterWarning':
      case 'setting':
      default:
        break;
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('soil_warning')) {
      this.syncSoilWarningThreshold(newSettings.soil_warning).catch(this.error);
      const soilMoisture = this.getCapabilityValue('measure_soil_moisture');
      if (typeof soilMoisture === 'number') {
        this.handleAdaptiveAlarm(soilMoisture, 'soil warning setting', true, !this.isDeviceSleepy()).catch(this.error);
      }
    }

    if (changedKeys.includes(this.getConfig().pollSettingId)) {
      const soilMoisture = this.getCapabilityValue('measure_soil_moisture');
      if (typeof soilMoisture === 'number') {
        this.handleAdaptiveAlarm(soilMoisture, 'poll interval setting', true, !this.isDeviceSleepy()).catch(this.error);
      }
    }

    if (this.isDeviceSleepy()) {
      this.pendingSettingsApply = true;
      this.log('Device is sleepy - queueing settings for next wake-up');
      return;
    }

    await this.applyDeviceSettings().catch(this.error);
  }

  isDeviceSleepy() {
    return this.node?.receiveWhenIdle === false;
  }

  async onEndDeviceAnnounce() {
    await this.onDeviceAwake('announce');
  }

  async onDeviceAwake(reason) {
    const store = this.getAdaptiveAlarmStore();
    const hadPendingSettingsApply = this.pendingSettingsApply;
    const hasPendingAdaptiveApply = store.pending_adaptive_apply === true;

    if (!hadPendingSettingsApply && !hasPendingAdaptiveApply) {
      return;
    }

    const now = Date.now();
    if (now - this.lastWakeHandledAt < 5000) {
      return;
    }
    this.lastWakeHandledAt = now;

    await this.setAvailable().catch(this.error);

    if (hadPendingSettingsApply) {
      await this.applyDeviceSettings().catch(this.error);
      this.pendingSettingsApply = false;
    }

    const soilMoisture = this.getCapabilityValue('measure_soil_moisture');
    if (typeof soilMoisture === 'number') {
      await this.handleAdaptiveAlarm(soilMoisture, `wake:${reason}`, true, true);
    }

    if (this.endpoint1) {
      await this.readBattery(this.endpoint1).catch(this.error);
    }
  }

  async readBattery(endpoint) {
    const cluster = endpoint.clusters[CLUSTER.POWER_CONFIGURATION.NAME];
    if (!cluster) {
      return;
    }

    try {
      const batteryStatus = await cluster.readAttributes(['batteryPercentageRemaining']);
      if (batteryStatus.batteryPercentageRemaining !== undefined && this.hasCapability('measure_battery')) {
        await this.updateBatteryCapability(Math.round(batteryStatus.batteryPercentageRemaining / 2), 'powerConfiguration');
      }
    } catch (error) {
      this.log('Could not read battery (device may be sleeping):', error);
    }
  }

  async registerPowerConfigurationBattery(endpoint) {
    if (this.hasCapability('measure_battery')) {
      await this.registerCapability('measure_battery', CLUSTER.POWER_CONFIGURATION);
    }

    const cluster = endpoint.clusters[CLUSTER.POWER_CONFIGURATION.NAME];
    if (!cluster?.on) {
      return;
    }

    cluster.on('attr.batteryPercentageRemaining', (batteryPercentageRemaining) => {
      if (this.hasCapability('measure_battery')) {
        this.updateBatteryCapability(Math.round(batteryPercentageRemaining / 2), 'powerConfiguration').catch(this.error);
      }
    });
  }

  async updateBatteryCapability(battery, source) {
    const previousBattery = this.lastBatteryPercentage;

    if (
      source === 'tuya'
      && previousBattery !== null
      && previousBattery >= 10
      && previousBattery <= 90
      && (battery === 0 || battery === 100)
      && Math.abs(battery - previousBattery) >= 40
    ) {
      this.log(`Ignoring implausible Tuya battery spike ${battery}% (previous ${previousBattery}%)`);
      return;
    }

    this.lastBatteryPercentage = battery;
    await this.updateCapabilityIfChanged('measure_battery', battery);
  }

  async updateCapabilityIfChanged(capability, value) {
    const previousValue = this.lastCapabilityValues.get(capability);
    if (previousValue === value) {
      return;
    }

    this.lastCapabilityValues.set(capability, value);
    await this.setCapabilityValue(capability, value);
  }

  async syncSoilWarningThreshold(value) {
    if (!this.hasCapability('soil_warning_threshold')) {
      return;
    }

    await this.setCapabilityValue('soil_warning_threshold', clampSoilWarning(value ?? this.getConfig().defaults.SOIL_WARNING_PERCENT)).catch(this.error);
  }

  getNormalPollInterval() {
    return clampSamplingSeconds(this.getSetting(this.getConfig().pollSettingId) ?? this.getConfig().defaults.SAMPLING_SECONDS);
  }

  getAdaptiveAlarmConfig() {
    return deriveAdaptiveAlarmConfig({
      alarmThreshold: clampSoilWarning(this.getSetting('soil_warning') ?? this.getConfig().defaults.SOIL_WARNING_PERCENT),
      pollInterval: this.getNormalPollInterval(),
    });
  }

  getAdaptiveAlarmStore() {
    return this.getStoreValue(this.constructor.ADAPTIVE_ALARM_STORE_KEY) || {};
  }

  async setAdaptiveAlarmStore(store) {
    await this.setStoreValue(this.constructor.ADAPTIVE_ALARM_STORE_KEY, store);
  }

  async restoreAdaptiveAlarmState(forceIntervalApply = false) {
    const soilMoisture = this.getCapabilityValue('measure_soil_moisture');
    if (typeof soilMoisture !== 'number') {
      return;
    }

    await this.handleAdaptiveAlarm(soilMoisture, 'init', forceIntervalApply, forceIntervalApply || !this.isDeviceSleepy());
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

    const lastReportInterval = Number.isFinite(store.last_report_interval) ? Number(store.last_report_interval) : null;
    const intervalNeedsApply = forceIntervalApply || lastReportInterval !== next.reportInterval;
    const activationNeedsInterval = !currentAlarm
      && next.alarmActive === true
      && next.state === STATES.ALARM_AGGRESSIVE
      && intervalNeedsApply;

    if (activationNeedsInterval && !allowIntervalApply) {
      await this.setAdaptiveAlarmStore({
        current_state: store.current_state || STATES.NORMAL,
        state_started_at: Number(store.state_started_at) || Date.now(),
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
      await this.applyAdaptiveSamplingInterval(next.reportInterval);
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

  async applyAdaptiveSamplingInterval(reportInterval) {
    if (!this.tuyaCluster) {
      return;
    }

    await this.tuyaCluster.setDatapointValue(this.getConfig().adaptiveSamplingDp, clampSamplingSeconds(reportInterval));
  }

  async configureMagicPacket(zclNode) {
    const endpoints = Object.values(zclNode.endpoints || {});
    const candidates = endpoints.filter((endpoint) => endpoint?.clusters?.[CLUSTER.BASIC.NAME]);
    for (const endpoint of candidates) {
      try {
        await endpoint.clusters[CLUSTER.BASIC.NAME].readAttributes([
          'manufacturerName',
          'zclVersion',
          'appVersion',
          'modelId',
          'powerSource',
        ]);
        return;
      } catch (error) {
        this.log('Tuya configureMagicPacket readAttributes failed on endpoint, trying next:', error);
      }
    }
  }

}

module.exports = TuyaSoilSensorDevice;
