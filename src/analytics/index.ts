/**
 * Telemetry public surface. Call sites should import only from this
 * barrel — the individual modules may be reorganized without
 * touching call sites.
 */

export {
  emit,
  flush,
  size,
  getSessionId,
  tierGate,
  BATCH_SIZE,
  BATCH_INTERVAL_MS,
} from './emitter'

export {
  loadConfig,
  saveConfig,
  setTier,
  TELEMETRY_BUILD_ENABLED,
  TELEMETRY_CONSOLE_MODE,
  TELEMETRY_SCHEMA_VERSION,
} from './config'
