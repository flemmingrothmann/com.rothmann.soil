'use strict';

const { Driver } = require('homey');

class ZG303ZDriver extends Driver {

  async onInit() {
    this.log('ZG-303Z soil moisture driver has been initialized');
  }

}

module.exports = ZG303ZDriver;
