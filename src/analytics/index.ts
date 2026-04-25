/**
 * Telemetry public surface. Call sites should import only from this
 * barrel — the individual modules may be reorganized without
 * touching call sites.
 */

export {
  emit,
  flush,
  flushOnUnload,
  size,
  getSessionId,
  getEventCount,
  getSessionDurationMs,
  tierGate,
  applyTierChange,
  setTransport,
  BATCH_SIZE,
  BATCH_INTERVAL_MS,
  BACKOFF_STEPS_MS,
} from './emitter'

export {
  createFetchTransport,
  classifyResponse,
  DEFAULT_ENDPOINT,
  PERSISTED_QUEUE_KEY,
  type Transport,
  type SendResult,
  type TransportOptions,
} from './transport'

export {
  loadConfig,
  saveConfig,
  setTier,
  TELEMETRY_BUILD_ENABLED,
  TELEMETRY_CONSOLE_MODE,
  TELEMETRY_SCHEMA_VERSION,
} from './config'

export {
  reportError,
  install as installErrorCapture,
  uninstall as uninstallErrorCapture,
  sanitizeMessage,
  normalizeStack,
} from './errorCapture'

export { initSession, emitSessionEnd } from './session'

export { startDwell, type DwellHandle } from './dwell'

export {
  emitCameraSettled,
  canEmitCameraSettled,
  CAMERA_SETTLED_MAX_PER_MINUTE,
} from './camera'

export {
  startPerfSampler,
  stopPerfSampler,
  pauseForVrEntry,
  resumeForVrExit,
} from './perfSampler'

export { hashQuery } from './hash'
