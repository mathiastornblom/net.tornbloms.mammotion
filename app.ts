import Homey from 'homey';

import { installCrashReporter } from './lib/util/CrashReporter.js';

/** Main Mammotion app entry point. */
export default class MammotionApp extends Homey.App {

  /** Installs crash reporting; all real initialization happens per-device in LubaDevice.onInit. */
  async onInit(): Promise<void> {
    installCrashReporter({
      release: `net.tornbloms.mammotion@${this.homey.manifest.version}`,
      homeyVersion: this.homey.version,
      isEnabled: () => this.homey.settings.get('crashReporting') !== false,
      log: (msg) => this.error(msg),
    });
    this.log(`Mammotion app initialized (v${this.homey.manifest.version})`);
  }

}
