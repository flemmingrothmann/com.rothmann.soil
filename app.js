'use strict';

const Homey = require('homey');
const { getDashboard } = require('./lib/soilDashboard');

class RothmannSoilApp extends Homey.App {

  async onInit() {
    this.log('Rothmann Soil has been initialized');
  }

  async getSoilDashboard() {
    return getDashboard(this.homey);
  }

}

module.exports = RothmannSoilApp;
