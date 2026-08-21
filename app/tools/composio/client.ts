/**
 * The Composio SDK client, constructed lazily. Nothing here runs unless
 * `readComposioConfig` returned a config, so an unconfigured deployment never
 * instantiates the SDK.
 */
import { Composio } from "@composio/core";
import type { ComposioConfig } from "./config.js";
import type { ComposioSdk } from "./sessions.js";

let instance: ComposioSdk | null = null;

export function resetComposioClient(): void {
  instance = null;
}

export function composioClient(config: ComposioConfig): ComposioSdk {
  if (!instance) {
    instance = new Composio({
      apiKey: config.apiKey,
      // Default telemetry registers its own SIGINT/SIGTERM handlers that
      // re-raise the signal (Telemetry.ts:349), which truncates the graceful
      // shutdown in server.ts:125. Also: this is a self-hosted product whose
      // operator never opted into third-party analytics.
      allowTracking: false,
      disableVersionCheck: true,
    }) as unknown as ComposioSdk;
  }
  return instance;
}
