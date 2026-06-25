import { createChangeQuery } from '#/cqn.js'

/**
 * Wrap a CQN subscription so its only externally visible effect is calling
 * `onWakeup(notification)` whenever the database says "something changed".
 * The actual row-level diffing happens in the detector's sweep — CQN here is
 * reduced to a low-latency "wake up and re-check" signal. The notification
 * payload (table, operation, rowids) is passed along for callers that want
 * to log it; sweep-driven callers are free to ignore it.
 *
 * Resilience properties:
 *   - if the subscription is deregistered by the database, we surface that
 *     via `onDeregistered` so the detector can attempt a fresh subscribe;
 *   - if subscribe() itself fails (Thin mode, missing privileges, network
 *     blip during startup), we throw — the detector decides whether to
 *     proceed timer-only or bail.
 *
 * The detector treats CQN as best-effort: a missing wake-up never means a
 * missed change, because the periodic sweep will catch it on the next tick.
 */
export async function startCqnWakeup({
  pool,
  query,
  onWakeup,
  onDeregistered,
  logger
}) {
  const subscription = await createChangeQuery({ pool, query })

  subscription.emitter.on('change', (notification) => {
    try {
      onWakeup(notification)
    } catch (err) {
      logger.error({ err }, 'CQN wake-up handler threw')
    }
  })

  subscription.emitter.on('deregistered', () => {
    logger.warn('CQN subscription deregistered by the database')

    try {
      onDeregistered?.()
    } catch (err) {
      logger.error({ err }, 'CQN deregistered handler threw')
    }
  })

  return {
    async stop() {
      try {
        await subscription.unsubscribe()
      } catch (err) {
        logger.warn({ err }, 'CQN unsubscribe failed (continuing shutdown)')
      }
    }
  }
}
