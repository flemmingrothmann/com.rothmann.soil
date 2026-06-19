'use strict';

const { configureWateringMode, getWateringMode, toggleWateringMode } = require('./lib/wateringMode');

module.exports = {
  async wateringMode({ homey }) {
    return getWateringMode(homey);
  },

  async toggleWateringMode({ homey }) {
    return toggleWateringMode(homey);
  },

  async configureWateringMode({ homey, body }) {
    return configureWateringMode(homey, body);
  },
};
