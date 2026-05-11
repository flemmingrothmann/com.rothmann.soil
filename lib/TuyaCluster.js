'use strict';

const { Cluster, ZCLDataTypes } = require('zigbee-clusters');

const TUYA_CLUSTER_ID = 61184;

const TuyaDataTypes = {
  RAW: 0x00,
  BOOL: 0x01,
  VALUE: 0x02,
  STRING: 0x03,
  ENUM: 0x04,
  BITMAP: 0x05,
};

class TuyaSpecificCluster extends Cluster {

  static get ID() {
    return TUYA_CLUSTER_ID;
  }

  static get NAME() {
    return 'tuya';
  }

  static get ATTRIBUTES() {
    return {};
  }

  static get COMMANDS() {
    return {
      datapoint: {
        id: 0x00,
        args: {
          status: ZCLDataTypes.uint8,
          transid: ZCLDataTypes.uint8,
          dp: ZCLDataTypes.uint8,
          datatype: ZCLDataTypes.uint8,
          length: ZCLDataTypes.uint16,
          data: ZCLDataTypes.buffer,
        },
      },
      reporting: {
        id: 0x01,
        args: {
          status: ZCLDataTypes.uint8,
          transid: ZCLDataTypes.uint8,
          dp: ZCLDataTypes.uint8,
          datatype: ZCLDataTypes.uint8,
          length: ZCLDataTypes.uint16,
          data: ZCLDataTypes.buffer,
        },
      },
      response: {
        id: 0x02,
        args: {
          status: ZCLDataTypes.uint8,
          transid: ZCLDataTypes.uint8,
          dp: ZCLDataTypes.uint8,
          datatype: ZCLDataTypes.uint8,
          length: ZCLDataTypes.uint16,
          data: ZCLDataTypes.buffer,
        },
      },
    };
  }

  async sendDatapoint(dp, datatype, data) {
    const transid = Math.floor(Math.random() * 255);
    const payload = Buffer.concat([
      Buffer.from([0, transid, dp, datatype]),
      Buffer.from([(data.length >> 8) & 0xff, data.length & 0xff]),
      data,
    ]);

    return this.sendFrame({
      frameControl: ['clusterSpecific', 'disableDefaultResponse'],
      cmdId: 0x00,
      data: payload,
    });
  }

  async setDatapointValue(dp, value) {
    const data = Buffer.alloc(4);
    data.writeInt32BE(value, 0);
    return this.sendDatapoint(dp, TuyaDataTypes.VALUE, data);
  }

  async setDatapointEnum(dp, value) {
    const data = Buffer.alloc(1);
    data.writeUInt8(value, 0);
    return this.sendDatapoint(dp, TuyaDataTypes.ENUM, data);
  }

}

Cluster.addCluster(TuyaSpecificCluster);

module.exports = {
  TUYA_CLUSTER_ID,
  TuyaDataTypes,
};
