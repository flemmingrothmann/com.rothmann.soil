'use strict';

const { Driver } = require('homey');

class ZS304ZDriver extends Driver {

  async onInit() {
    this.log('ZS-304Z soil driver has been initialized');
  }

}

module.exports = ZS304ZDriver;
