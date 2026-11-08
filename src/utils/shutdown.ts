/**
 * Shared shutdown lifecycle state module.
 *
 * Provides a decoupled, dependency-free single source of truth for graceful shutdown state.
 * Prevents circular dependencies between server runtime, HTTP layer, and socket middleware.
 */

let isShuttingDown = false;

/**
 * Returns true if a graceful shutdown sequence is currently in progress.
 */
export function isShutdownInProgress(): boolean {
  return isShuttingDown;
}

/**
 * Updates the shutdown state. Called by gracefulShutdown() when beginning the sequence.
 */
export function setShutdownInProgress(value: boolean): void {
  isShuttingDown = value;
}

/**
 * Resets the shutdown state. Exposed exclusively for test isolation across test runs.
 */
export function resetShutdownState(): void {
  isShuttingDown = false;
}

