'use strict';

const { Driver } = require('homey');

class ZS301ZDriver extends Driver {

  async onInit() {
    this.log('ZS-301Z soil driver has been initialized');
  }

}

module.exports = ZS301ZDriver;
