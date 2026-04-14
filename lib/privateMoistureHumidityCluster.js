'use strict';

const { ZCLDataTypes, Cluster } = require('zigbee-clusters');

const ATTRIBUTES = {
  measuredValue: { id: 0, type: ZCLDataTypes.uint16 },
};

class PrivateMoistureHumidityCluster extends Cluster {

  static get ID() {
    return 1032;
  }

  static get NAME() {
    return 'privateMoistureHumidity';
  }

  static get ATTRIBUTES() {
    return ATTRIBUTES;
  }

  static get COMMANDS() {
    return {};
  }

}

Cluster.addCluster(PrivateMoistureHumidityCluster);

module.exports = PrivateMoistureHumidityCluster;
