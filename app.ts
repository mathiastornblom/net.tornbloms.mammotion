
import Homey from 'homey';

/** Main Mammotion app entry point. */
export default class MammotionApp extends Homey.App {

  async onInit(): Promise<void> {
    this.log(`Mammotion app initialized (v${this.homey.manifest.version})`);
  }

}
