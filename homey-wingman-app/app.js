'use strict';

const Homey = require('homey');
const { HomeyWingmanBridge } = require('./lib/homeyWingmanBridge');

class HomeyWingmanApp extends Homey.App {

  async onInit() {
    this.log('Homey Wingman has been initialized');
    this.bridge = new HomeyWingmanBridge(this.homey, this.log.bind(this), this.error.bind(this));
    await this.bridge.start();
  }

}

module.exports = HomeyWingmanApp;
