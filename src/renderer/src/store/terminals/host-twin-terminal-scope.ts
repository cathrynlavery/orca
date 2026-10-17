import type { AppState } from '../types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { normalizeWorktreePurgeTarget } from '../slices/worktree-purge-target'
import { collectHostTwinPurgeScopes } from '../slices/worktrees/teardown/host-twin-worktree-purge'
import { collectRemovedHostTwinState } from '../repos/repo-removal-host-twin-attribution'
import { findKnownWorktreeById } from '../slices/worktrees/listing/detected-worktree-meta'
import { collectPtyIdsForTab } from '../slices/terminal-tab-retirement'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { resolveTerminalTeardownOwner, type TerminalTeardownOwner } from './terminal-teardown-owner'

/** One host's terminals under a worktree id that another host still publishes. */
export type HostTwinTerminalScope = {
  /** The host the tabs are attributed to (a paired runtime's SSH copy names its SSH host). */
  hostId: ExecutionHostId
  tabIds: ReadonlySet<string>
  /** Pane keys under those tabs in any agent map, so per-pane records stay with their host. */
  paneKeys: string[]
  /** The runtime that stops this copy: the one the target names, or the one its SSH row runs on. */
  runtimeEnvironmentId: string | null
  /** Target-host panes inside tabs another host's pane shares; their teardown is refused. */
  mixedTabPtyIds: ReadonlySet<string>
  /** Live tabs no host can be shown to own; their teardown is refused too. */
  unattributedLiveTabIds: ReadonlySet<string>
  /** Whether the target's tabs still name a PTY (layout, reconnect or relay hint). */
  hasPtyEvidence: boolean
}

function paneKeysForTabs(state: AppState, tabIds: ReadonlySet<string>): string[] {
  const keys = new Set<string>()
  for (const map of [
    state.agentStatusByPaneKey,
    state.retainedAgentsByPaneKey,
    state.sleepingAgentSessionsByPaneKey,
    state.agentLaunchConfigByPaneKey
  ]) {
    for (const paneKey of Object.keys(map ?? {})) {
      const separator = paneKey.indexOf(':')
      if (separator > 0 && tabIds.has(paneKey.slice(0, separator))) {
        keys.add(paneKey)
      }
    }
  }
  return [...keys]
}

/**
 * Null for a raw id or when no other host publishes the id: the caller acts on the whole worktree
 * as before. Otherwise only the tabs attributed to the target host, by #29954's attribution.
 */
export function resolveHostTwinTerminalScope(
  state: AppState,
  target: string | HostWorktreeTarget
): HostTwinTerminalScope | null {
  if (typeof target === 'string') {
    return null
  }
  const [scope] = collectHostTwinPurgeScopes(state, [normalizeWorktreePurgeTarget(target)]).byHost
  if (!scope) {
    return null
  }
  const [hostId, twinHostIds] = scope
  const { terminalTabIds, mixedTabPtyIds } = collectRemovedHostTwinState(
    state,
    new Set([target.worktreeId]),
    hostId,
    twinHostIds
  )
  const requested = parseExecutionHostId(target.hostId)
  const row = findKnownWorktreeById(state, target.worktreeId, target.hostId)
  const survivors = twinHostIds.get(target.worktreeId) ?? []
  const survivorTabIds = new Set(
    survivors.flatMap((survivor) => [
      ...collectRemovedHostTwinState(
        state,
        new Set([target.worktreeId]),
        survivor,
        new Map([[target.worktreeId, [hostId, ...survivors.filter((other) => other !== survivor)]]])
      ).terminalTabIds
    ])
  )
  // Why: a live tab no host can claim may be the target's, so stopping the rest is not a sleep.
  const unattributedLiveTabIds = new Set(
    (state.tabsByWorktree[target.worktreeId] ?? [])
      .filter(
        (tab) =>
          (state.ptyIdsByTabId[tab.id]?.length ?? 0) > 0 &&
          !terminalTabIds.has(tab.id) &&
          !survivorTabIds.has(tab.id)
      )
      .map((tab) => tab.id)
  )
  return {
    hostId,
    tabIds: terminalTabIds,
    paneKeys: paneKeysForTabs(state, terminalTabIds),
    runtimeEnvironmentId:
      requested?.kind === 'runtime'
        ? requested.environmentId
        : (row?.runtimeOwnerEnvironmentId?.trim() ?? null) || null,
    mixedTabPtyIds,
    unattributedLiveTabIds,
    hasPtyEvidence: (state.tabsByWorktree[target.worktreeId] ?? []).some(
      (tab) =>
        terminalTabIds.has(tab.id) && collectPtyIdsForTab(state, tab.id, tab.ptyId).length > 0
    )
  }
}

/**
 * The target names the host, so nothing is ambiguous unless its attributed panes are runtime PTYs:
 * a paired runtime's SSH copy runs them there, and each id names its runtime.
 */
export function resolveHostTwinTeardownOwner(
  scope: HostTwinTerminalScope,
  ptyIds: readonly string[],
  backendOwnsPtyTeardown: boolean
): TerminalTeardownOwner {
  // Why: a split tab shared with the twin can't lose only some panes here, so nothing is stopped.
  if (
    (scope.mixedTabPtyIds.size > 0 || scope.unattributedLiveTabIds.size > 0) &&
    !backendOwnsPtyTeardown
  ) {
    return { kind: 'refused', reason: 'ambiguous_terminal_owner' }
  }
  // Why: with no bound PTY a hinted shell may still run on its host; no binding proves no death.
  if (
    ptyIds.length === 0 &&
    scope.hasPtyEvidence &&
    !scope.runtimeEnvironmentId &&
    !backendOwnsPtyTeardown
  ) {
    return { kind: 'refused', reason: 'ambiguous_terminal_owner' }
  }
  if (scope.runtimeEnvironmentId || !ptyIds.some(isRemoteRuntimePtyId)) {
    return { kind: 'resolved', runtimeEnvironmentId: scope.runtimeEnvironmentId }
  }
  return resolveTerminalTeardownOwner({ kind: 'ambiguous' }, ptyIds)
}

export function worktreeIdOfTarget(target: string | HostWorktreeTarget): string {
  return typeof target === 'string' ? target : target.worktreeId
}

/**
 * Ids a batch names on every host that publishes them: no copy stays awake, so the shared
 * raw-id state (sleep marker, browsers, VM) is handled once, while each copy's terminals still
 * stop on their own host.
 */
export function collectFullyTargetedTwinIds(
  state: AppState,
  targets: readonly (string | HostWorktreeTarget)[]
): Set<string> {
  const hostTargetsById = new Map<string, HostWorktreeTarget[]>()
  for (const target of targets) {
    if (typeof target !== 'string') {
      hostTargetsById.set(target.worktreeId, [
        ...(hostTargetsById.get(target.worktreeId) ?? []),
        target
      ])
    }
  }
  return new Set(
    [...hostTargetsById]
      .filter(
        ([, group]) =>
          group.length > 1 &&
          collectHostTwinPurgeScopes(state, group.map(normalizeWorktreePurgeTarget)).byHost.size ===
            0
      )
      .map(([id]) => id)
  )
}
