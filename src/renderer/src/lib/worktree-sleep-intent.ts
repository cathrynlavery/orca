// Why: a slept workspace keeps its panes mounted with only dead PTYs behind them.
// Any pane connect that runs while the marker is set waits here, and the clear
// that marks the workspace awake resumes every waiting connect.
const sleepingWorktreeIds = new Set<string>()
const tearingDownWorktreeIds = new Set<string>()
const wakeListenersByWorktreeId = new Map<string, Set<() => void>>()

export function markWorktreeSleepIntent(worktreeId: string): void {
  sleepingWorktreeIds.add(worktreeId)
}

/**
 * Why: a spawn that resolves while the sleep teardown is still awaiting its host
 * would bind a PTY and clear the marker, waking every waiting pane mid-sleep.
 * Binds during the teardown window are not wakes.
 */
export async function withWorktreeSleepTeardown<T>(
  worktreeId: string,
  teardown: () => Promise<T>
): Promise<T> {
  tearingDownWorktreeIds.add(worktreeId)
  try {
    return await teardown()
  } finally {
    tearingDownWorktreeIds.delete(worktreeId)
  }
}

export function clearWorktreeSleepIntent(worktreeId: string | null): void {
  if (!worktreeId || tearingDownWorktreeIds.has(worktreeId)) {
    return
  }
  if (!sleepingWorktreeIds.delete(worktreeId)) {
    return
  }
  const listeners = wakeListenersByWorktreeId.get(worktreeId)
  wakeListenersByWorktreeId.delete(worktreeId)
  for (const listener of listeners ?? []) {
    try {
      listener()
    } catch (error) {
      // Why: one pane's connect failure must not strand its siblings or throw out of a store action.
      console.error('[sleep-intent] wake listener failed', { worktreeId, error })
    }
  }
}

// Why: a purged worktree must not wake its panes; they are being unmounted.
export function forgetWorktreeSleepIntent(worktreeId: string): void {
  sleepingWorktreeIds.delete(worktreeId)
  tearingDownWorktreeIds.delete(worktreeId)
  wakeListenersByWorktreeId.delete(worktreeId)
}

export function hasWorktreeSleepIntent(worktreeId: string | null): boolean {
  return worktreeId !== null && sleepingWorktreeIds.has(worktreeId)
}

export function onWorktreeSleepIntentCleared(worktreeId: string, listener: () => void): () => void {
  const listeners = wakeListenersByWorktreeId.get(worktreeId) ?? new Set<() => void>()
  listeners.add(listener)
  wakeListenersByWorktreeId.set(worktreeId, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && wakeListenersByWorktreeId.get(worktreeId) === listeners) {
      wakeListenersByWorktreeId.delete(worktreeId)
    }
  }
}

// Why: when one host's copy of a twin sleeps, the shared id stays unmarked for the awake copy,
// so the slept copy's tabs are fenced one by one instead.
const sleepingTabIds = new Set<string>()
const wakeListenersByTabId = new Map<string, Set<() => void>>()

export function markTabSleepIntent(tabIds: Iterable<string>): void {
  for (const tabId of tabIds) {
    sleepingTabIds.add(tabId)
  }
}

const tearingDownTabIds = new Set<string>()

/** The per-tab form of `withWorktreeSleepTeardown`, for one copy of a twin. */
export async function withTabSleepTeardown<T>(
  tabIds: Iterable<string>,
  teardown: () => Promise<T>
): Promise<T> {
  const ids = [...tabIds]
  for (const tabId of ids) {
    tearingDownTabIds.add(tabId)
  }
  try {
    return await teardown()
  } finally {
    for (const tabId of ids) {
      tearingDownTabIds.delete(tabId)
    }
  }
}

/** Wakes fenced tabs; a bind during their own sleep teardown is not a wake. */
export function clearTabSleepIntent(worktreeId: string, tabIds: Iterable<string>): void {
  if (tearingDownWorktreeIds.has(worktreeId)) {
    return
  }
  for (const tabId of tabIds) {
    if (tearingDownTabIds.has(tabId) || !sleepingTabIds.delete(tabId)) {
      continue
    }
    const listeners = wakeListenersByTabId.get(tabId)
    wakeListenersByTabId.delete(tabId)
    for (const listener of listeners ?? []) {
      try {
        listener()
      } catch (error) {
        console.error('[sleep-intent] wake listener failed', { worktreeId, error })
      }
    }
  }
}

export function hasPaneSleepIntent(worktreeId: string, tabId: string): boolean {
  return sleepingWorktreeIds.has(worktreeId) || sleepingTabIds.has(tabId)
}

/** Fires once when the worktree's or the tab's fence clears; the caller checks both again. */
export function onPaneSleepIntentCleared(
  worktreeId: string,
  tabId: string,
  listener: () => void
): () => void {
  const listeners = wakeListenersByTabId.get(tabId) ?? new Set<() => void>()
  let unsubscribeWorktree = (): void => {}
  const unsubscribe = (): void => {
    unsubscribeWorktree()
    listeners.delete(once)
    if (listeners.size === 0 && wakeListenersByTabId.get(tabId) === listeners) {
      wakeListenersByTabId.delete(tabId)
    }
  }
  function once(): void {
    unsubscribe()
    listener()
  }
  unsubscribeWorktree = onWorktreeSleepIntentCleared(worktreeId, once)
  listeners.add(once)
  wakeListenersByTabId.set(tabId, listeners)
  return unsubscribe
}
