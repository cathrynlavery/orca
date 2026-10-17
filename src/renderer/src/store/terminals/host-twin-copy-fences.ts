import type { AppState } from '../types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { listWorkspacePublisherHostIds } from '../slices/worktrees/teardown/host-twin-worktree-purge'
import {
  hasTabSleepFence,
  hasWorktreeSleepIntent,
  markCopySleepIntent
} from '@/lib/worktree-sleep-intent'
import {
  collectTerminalTabOwners,
  tabsOwnedBy,
  type TerminalTabOwners
} from './host-twin-terminal-scope'

// Per-copy sleep fences for a twin: each copy's tabs are recorded under its host, so waking
// one copy never re-arms another.

function fenceCopiesExcept(
  worktreeId: string,
  hostIds: readonly ExecutionHostId[],
  owners: TerminalTabOwners,
  wokenHostId: ExecutionHostId | null,
  exceptTabIds: readonly string[]
): string[] {
  const newlyFenced: string[] = []
  for (const hostId of hostIds) {
    if (hostId === wokenHostId) {
      continue
    }
    const fenced = [...tabsOwnedBy(owners, hostId)].filter((id) => !exceptTabIds.includes(id))
    newlyFenced.push(...fenced.filter((tabId) => !hasTabSleepFence(tabId)))
    markCopySleepIntent(worktreeId, hostId, fenced)
  }
  return newlyFenced
}

/**
 * Before a wake clears the shared marker, the copies not woken get per-tab fences, so waking one
 * copy of a twin never re-arms another.
 */
export function fenceTwinCopiesBeforeSharedWake(
  state: AppState,
  worktreeId: string,
  wokenHostId: ExecutionHostId
): void {
  if (!hasWorktreeSleepIntent(worktreeId)) {
    return
  }
  const hostIds = listWorkspacePublisherHostIds(state, worktreeId)
  if (hostIds.length >= 2) {
    fenceCopiesExcept(
      worktreeId,
      hostIds,
      collectTerminalTabOwners(state, worktreeId, hostIds),
      wokenHostId,
      []
    )
  }
}

/**
 * A raw-id sleep of a twin records every copy's tabs too: its sleep removes the evidence that
 * attributes some of them, so opening one copy later must not wake the other copy's tabs.
 * Returns the tabs it newly fenced, so a failed sleep can take back only those.
 */
export function fenceEveryTwinCopy(state: AppState, worktreeId: string): string[] {
  const hostIds = listWorkspacePublisherHostIds(state, worktreeId)
  return hostIds.length < 2
    ? []
    : fenceCopiesExcept(
        worktreeId,
        hostIds,
        collectTerminalTabOwners(state, worktreeId, hostIds),
        null,
        []
      )
}

/**
 * For a bind while any sleep fence is set: the bound tab's copy, in one attribution pass, with
 * the other copies fenced first when the shared marker is set. Null without a twin.
 */
export function prepareTwinBindWake(
  state: AppState,
  worktreeId: string,
  tabId: string
): ExecutionHostId | null {
  const hostIds = listWorkspacePublisherHostIds(state, worktreeId)
  if (hostIds.length < 2) {
    return null
  }
  const owners = collectTerminalTabOwners(state, worktreeId, hostIds)
  const copyHostId = owners.ownerByTabId.get(tabId) ?? null
  if (hasWorktreeSleepIntent(worktreeId)) {
    fenceCopiesExcept(worktreeId, hostIds, owners, copyHostId, [tabId])
  }
  return copyHostId
}
