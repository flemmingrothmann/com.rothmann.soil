'use strict';

const { Driver } = require('homey');

class SoilMoistureSensorDriver extends Driver {

  async onInit() {
    this.log('Third Reality soil moisture driver has been initialized');
  }

}

module.exports = SoilMoistureSensorDriver;
