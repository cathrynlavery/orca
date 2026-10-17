import type { AppState } from '../types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { normalizeWorktreePurgeTarget } from '../slices/worktree-purge-target'
import { collectHostTwinPurgeScopes } from '../slices/worktrees/teardown/host-twin-worktree-purge'
import { collectRemovedHostTwinState } from '../repos/repo-removal-host-twin-attribution'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { resolveTerminalTeardownOwner, type TerminalTeardownOwner } from './terminal-teardown-owner'

/** One host's terminals under a worktree id that another host still publishes. */
export type HostTwinTerminalScope = {
  /** The host the tabs are attributed to (a paired runtime's SSH copy names its SSH host). */
  hostId: ExecutionHostId
  tabIds: ReadonlySet<string>
  /** Pane keys under those tabs in any agent map, so per-pane records stay with their host. */
  paneKeys: string[]
  /** The runtime the target names, which stops its own copy; null for local and SSH. */
  runtimeEnvironmentId: string | null
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
  const { terminalTabIds } = collectRemovedHostTwinState(
    state,
    new Set([target.worktreeId]),
    hostId,
    twinHostIds
  )
  const requested = parseExecutionHostId(target.hostId)
  return {
    hostId,
    tabIds: terminalTabIds,
    paneKeys: paneKeysForTabs(state, terminalTabIds),
    runtimeEnvironmentId: requested?.kind === 'runtime' ? requested.environmentId : null
  }
}

/**
 * The target names the host, so nothing is ambiguous unless its attributed panes are runtime PTYs:
 * a paired runtime's SSH copy runs them there, and each id names its runtime.
 */
export function resolveHostTwinTeardownOwner(
  scope: HostTwinTerminalScope,
  ptyIds: readonly string[]
): TerminalTeardownOwner {
  if (scope.runtimeEnvironmentId || !ptyIds.some(isRemoteRuntimePtyId)) {
    return { kind: 'resolved', runtimeEnvironmentId: scope.runtimeEnvironmentId }
  }
  return resolveTerminalTeardownOwner({ kind: 'ambiguous' }, ptyIds)
}

export function worktreeIdOfTarget(target: string | HostWorktreeTarget): string {
  return typeof target === 'string' ? target : target.worktreeId
}
