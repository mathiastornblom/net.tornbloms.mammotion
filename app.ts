'use strict';

import Homey from 'homey';

/** Main Mammotion app entry point. */
module.exports = class MammotionApp extends Homey.App {

  async onInit(): Promise<void> {
    this.log('Mammotion app initialized');
  }

};
