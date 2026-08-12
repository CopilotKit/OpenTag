import "dotenv/config";
import { installLogExporter } from "./log-exporter.js";

// This module is imported before the runtime dependency graph so dependency
// output is mirrored too. The default configuration leaves streams untouched.
export const logExporter = installLogExporter({
  env: { ...process.env, OPENTAG_LOG_COMPONENT: "runtime" },
});
