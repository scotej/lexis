/**
 * A small queue that keeps a few of something ready before anyone asks.
 *
 * The something here is AI-written passages. A typing test that pauses for
 * four seconds while a model composes is not a typing test — the whole
 * experience is "press a key, the timer starts" — so the passages have to
 * exist before the typist wants them. This keeps a handful in hand and quietly
 * tops the queue up whenever it dips, so the wait only ever happens once, on
 * the very first request, and even that can be started when the view opens
 * rather than when the test does.
 *
 * Deliberately generic and clock-injected: nothing here knows about OpenRouter,
 * which is what lets its failure handling be tested in milliseconds instead of
 * across real backoffs.
 */

/**
 * @param produce   () => Promise<item[]>  — one batch; may reject
 * @param size      how many to hold ready
 * @param lowWater  refill when the queue drops to this
 * @param onChange  called whenever `state()` would answer differently
 * @param backoffMs first retry delay after a failure; doubles, to maxBackoffMs
 */
export function createPrefetcher({
  produce,
  size = 4,
  lowWater = 2,
  onChange = () => {},
  backoffMs = 4000,
  maxBackoffMs = 120000,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
} = {}) {
  let queue = [];
  let inFlight = null;
  let failures = 0;
  let error = null;
  let retryAt = 0;
  let retryHandle = null;
  let stopped = false;
  let generation = 0; // bumped by reset(): an in-flight batch for the old settings must not land

  function announce() {
    try {
      onChange(state());
    } catch {
      /* a listener's problem is not the queue's problem */
    }
  }

  function state() {
    return {
      ready: queue.length,
      size,
      filling: Boolean(inFlight),
      error,
      // A failure the queue is still waiting out. Worth distinguishing from a
      // dead one: the interface can say "retrying" instead of offering a
      // button that does what is already about to happen.
      retryingAt: retryAt > now() ? retryAt : 0,
    };
  }

  function cancelRetry() {
    if (retryHandle != null) {
      clearTimer(retryHandle);
      retryHandle = null;
    }
    retryAt = 0;
  }

  function scheduleRetry() {
    if (stopped || retryHandle != null) return;
    const wait = Math.min(maxBackoffMs, backoffMs * 2 ** Math.max(0, failures - 1));
    retryAt = now() + wait;
    const mine = generation;
    retryHandle = setTimer(() => {
      retryHandle = null;
      retryAt = 0;
      if (stopped || mine !== generation) return;
      fill();
    }, wait);
  }

  function fill() {
    if (stopped || inFlight || queue.length >= size) return;
    if (retryHandle != null) return; // already waiting out a failure

    const mine = generation;
    const want = size - queue.length;
    inFlight = Promise.resolve()
      .then(() => produce(want))
      .then((batch) => {
        inFlight = null;
        if (stopped || mine !== generation) return;
        // Only a missing item is dropped. Filtering on truthiness instead would
        // silently discard a legitimate 0 or "" and then report the batch as
        // short — a queue this generic has no business deciding which values
        // are worth having.
        const items = Array.isArray(batch)
          ? batch.filter((item) => item != null)
          : batch == null
            ? []
            : [batch];
        if (items.length) {
          failures = 0;
          error = null;
          queue = queue.concat(items).slice(0, size);
        } else {
          // A batch that came back empty is a failure with a polite face: retry
          // it on the same backoff, or the queue spins producing nothing.
          failures++;
          error = new Error("nothing came back");
          scheduleRetry();
        }
        announce();
        if (queue.length < size && !error) fill();
      })
      .catch((err) => {
        inFlight = null;
        if (stopped || mine !== generation) return;
        failures++;
        error = err instanceof Error ? err : new Error(String(err));
        scheduleRetry();
        announce();
      });
    announce();
    return inFlight;
  }

  return {
    state,

    /** The next ready item, or null. Taking one is what triggers the top-up. */
    take() {
      const item = queue.shift() ?? null;
      if (item) announce();
      // Clear a backoff on a successful take: the queue is being used, which is
      // the moment to try again rather than sit out the rest of a two-minute wait.
      if (item && error && queue.length <= lowWater) {
        failures = Math.max(0, failures - 1);
        cancelRetry();
      }
      if (queue.length <= lowWater) fill();
      return item;
    },

    /** Everything ready right now, without taking it — for a "coming up" list. */
    peek() {
      return [...queue];
    },

    /** Start filling. Safe to call repeatedly; it is a no-op once full. */
    prime() {
      stopped = false;
      return fill();
    },

    /**
     * Throw the queue away — the settings behind it changed.
     *
     * Passages built around yesterday's bank words are worse than no passages
     * at all: they are stale in a way the typist cannot see and would keep
     * being served for as long as the queue held them.
     */
    reset() {
      generation++;
      cancelRetry();
      queue = [];
      inFlight = null;
      failures = 0;
      error = null;
      announce();
    },

    /** Try again now, ignoring the backoff — a person pressed the button. */
    retry() {
      cancelRetry();
      failures = 0;
      error = null;
      announce();
      return fill();
    },

    /** No further work, and nothing in flight will land. */
    stop() {
      stopped = true;
      generation++;
      cancelRetry();
      inFlight = null;
    },
  };
}
