'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');

class SoilMoistureSensorDevice extends ZigBeeDevice {

  static SOIL_WARNING_DEFAULT = 30;
  static SOIL_WARNING_HYSTERESIS = 2;

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
    const threshold = this.getSoilWarningThreshold();

    this.log('measure_soil_moisture:', parsedValue, '+ offset', humidityOffset);
    this.setCapabilityValue('measure_soil_moisture', soilMoisture).catch(this.error);
    this.updateDrySoilAlarm(soilMoisture, threshold);
  }

  onBatteryPercentageRemainingAttributeReport(batteryPercentageRemaining) {
    this.onDeviceAwake('battery report').catch(this.error);

    this.log('measure_battery:', batteryPercentageRemaining / 2);
    this.setCapabilityValue('measure_battery', batteryPercentageRemaining / 2).catch(this.error);
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('soil_warning')) {
      this.syncSoilWarningThreshold(newSettings.soil_warning).catch(this.error);
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
    if (!this.pendingSettingsApply) {
      return;
    }

    const now = Date.now();
    const debounceMs = 5000;

    if (now - this.lastWakeHandledAt < debounceMs) {
      return;
    }

    this.lastWakeHandledAt = now;
    this.log(`Applying pending reporting settings after ${reason}`);

    await this.setTemperatureAndHumidityConfigReport(this.getSettings(), this.getSettings(), [
      'temperature_report_min_interval',
      'temperature_report_max_interval',
      'temperature_report_change',
      'humidity_report_min_interval',
      'humidity_report_max_interval',
      'humidity_report_change',
    ]);

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

    const soilMoisture = this.getCapabilityValue('measure_soil_moisture');
    if (typeof soilMoisture === 'number') {
      this.updateDrySoilAlarm(soilMoisture, threshold);
    }
  }

  updateDrySoilAlarm(soilMoisture, threshold) {
    const currentAlarm = this.getCapabilityValue('alarm_water');

    if (currentAlarm === true) {
      if (soilMoisture >= threshold + SoilMoistureSensorDevice.SOIL_WARNING_HYSTERESIS) {
        this.setCapabilityValue('alarm_water', false).catch(this.error);
      }
      return;
    }

    if (soilMoisture < threshold) {
      this.setCapabilityValue('alarm_water', true).catch(this.error);
    }
  }

}

module.exports = SoilMoistureSensorDevice;
