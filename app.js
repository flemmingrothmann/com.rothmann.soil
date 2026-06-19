'use strict';

const Homey = require('homey');

class RothmannSoilApp extends Homey.App {

  async onInit() {
    this.log('Rothmann Soil has been initialized');
  }

}

module.exports = RothmannSoilApp;
