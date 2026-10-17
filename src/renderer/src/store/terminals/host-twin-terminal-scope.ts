import type { AppState } from '../types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { normalizeWorktreePurgeTarget } from '../slices/worktree-purge-target'
import {
  collectHostTwinPurgeScopes,
  listWorkspacePublisherHostIds
} from '../slices/worktrees/teardown/host-twin-worktree-purge'
import { removedHostCanonicalizer } from '../repos/repo-removal-host-twin-attribution'
import {
  belongsToRemovedHost,
  ptyHostEvidence,
  terminalTabBelongsToHost,
  terminalTabPtyEvidence,
  type HostEvidence
} from '../repos/host-twin-terminal-evidence'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/resolve-owner'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { hasWorktreeSleepIntent, markCopySleepIntent } from '@/lib/worktree-sleep-intent'
import { resolveTerminalTeardownOwner, type TerminalTeardownOwner } from './terminal-teardown-owner'

/** One host's terminals under a worktree id that another host still publishes. */
export type HostTwinTerminalScope = {
  /** The copy's host as attributed (a paired runtime's SSH copy names its SSH host); keys its fence. */
  copyHostId: ExecutionHostId
  tabIds: ReadonlySet<string>
  /** Pane keys under those tabs in any agent map, so per-pane records stay with their host. */
  paneKeys: string[]
  /** The runtime that stops this copy: the one the target names, or the one its SSH row runs on. */
  runtimeEnvironmentId: string | null
  /** Target-host panes inside tabs another host's pane shares; their teardown is refused. */
  mixedTabPtyIds: ReadonlySet<string>
  /** The target's own row resolves to more than one server, so nothing can be routed. */
  ownerAmbiguous: boolean
  /** Tabs with PTY evidence no host can be shown to own. */
  unattributedTabIds: ReadonlySet<string>
  /** Whether the target's tabs still name a PTY (layout, reconnect or relay hint). */
  hasPtyEvidence: boolean
}

type TerminalTabOwners = {
  /** The one host a terminal tab belongs to, or null when none or several can claim it. */
  ownerByTabId: Map<string, ExecutionHostId | null>
  evidenceByTabId: Map<string, HostEvidence[]>
  /** Per host, its live panes inside tabs it does not wholly own. */
  mixedPtyIdsByHost: Map<ExecutionHostId, Set<string>>
}

/** Attributes every terminal tab of a workspace to one of `hostIds` in a single pass. */
function collectTerminalTabOwners(
  state: AppState,
  worktreeId: string,
  hostIds: readonly ExecutionHostId[]
): TerminalTabOwners {
  const hosts = hostIds.map((hostId) => {
    const others = hostIds.filter((other) => other !== hostId)
    return {
      hostId,
      others,
      canonical: removedHostCanonicalizer(state, worktreeId, hostId, others)
    }
  })
  const unifiedTerminals = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
    (tab) => tab.contentType === 'terminal'
  )
  const stampByEntityId = new Map(
    unifiedTerminals.flatMap((tab) =>
      tab.executionHostId ? [[tab.entityId, tab.executionHostId] as const] : []
    )
  )
  const legacy = state.tabsByWorktree[worktreeId] ?? []
  const legacyIds = new Set(legacy.map((tab) => tab.id))
  // Why unified-only too: a restored terminal can exist only as a unified tab until it mounts.
  const tabs = [
    ...legacy.map((tab) => ({ id: tab.id, ptyId: tab.ptyId })),
    ...unifiedTerminals
      .filter((tab) => !legacyIds.has(tab.entityId))
      .map((tab) => ({ id: tab.entityId, ptyId: null }))
  ]
  const owners: TerminalTabOwners = {
    ownerByTabId: new Map(),
    evidenceByTabId: new Map(),
    mixedPtyIdsByHost: new Map()
  }
  for (const tab of tabs) {
    const evidence = terminalTabPtyEvidence(state, tab.id, tab.ptyId)
    const stamp = stampByEntityId.get(tab.id)
    const claimants = hosts.filter(({ hostId, others, canonical }) =>
      terminalTabBelongsToHost(
        stamp ? canonical(stamp) : undefined,
        evidence,
        hostId,
        others,
        canonical
      )
    )
    const owner = claimants.length === 1 ? claimants[0].hostId : null
    owners.ownerByTabId.set(tab.id, owner)
    owners.evidenceByTabId.set(tab.id, evidence)
    for (const { hostId, others, canonical } of hosts) {
      if (owner === hostId) {
        continue
      }
      for (const ptyId of state.ptyIdsByTabId[tab.id] ?? []) {
        if (belongsToRemovedHost(canonical(ptyHostEvidence(ptyId)), hostId, others)) {
          const mixed = owners.mixedPtyIdsByHost.get(hostId) ?? new Set<string>()
          owners.mixedPtyIdsByHost.set(hostId, mixed.add(ptyId))
        }
      }
    }
  }
  return owners
}

function tabsOwnedBy(owners: TerminalTabOwners, hostId: ExecutionHostId): Set<string> {
  return new Set(
    [...owners.ownerByTabId].flatMap(([tabId, owner]) => (owner === hostId ? [tabId] : []))
  )
}

export function paneKeysForTabs(state: AppState, tabIds: ReadonlySet<string>): string[] {
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
  const [copyHostId, twinHostIds] = scope
  const owners = collectTerminalTabOwners(state, target.worktreeId, [
    copyHostId,
    ...(twinHostIds.get(target.worktreeId) ?? [])
  ])
  const tabIds = tabsOwnedBy(owners, copyHostId)
  const requested = parseExecutionHostId(target.hostId)
  // Why the owner resolver: a paired runtime's SSH copy may record its transport on any of its rows.
  const owner = runtimeEnvironmentIdForWorkspaceOwner(state, {
    workspaceId: target.worktreeId,
    hostId: target.hostId
  })
  const hasEvidence = (tabId: string): boolean =>
    (owners.evidenceByTabId.get(tabId)?.length ?? 0) > 0
  return {
    copyHostId,
    tabIds,
    paneKeys: paneKeysForTabs(state, tabIds),
    runtimeEnvironmentId:
      requested?.kind === 'runtime'
        ? requested.environmentId
        : owner.kind === 'resolved'
          ? owner.environmentId
          : null,
    ownerAmbiguous: requested?.kind !== 'runtime' && owner.kind === 'ambiguous',
    mixedTabPtyIds: owners.mixedPtyIdsByHost.get(copyHostId) ?? new Set(),
    unattributedTabIds: new Set(
      [...owners.ownerByTabId].flatMap(([tabId, tabOwner]) =>
        tabOwner === null && hasEvidence(tabId) ? [tabId] : []
      )
    ),
    hasPtyEvidence: [...tabIds].some(hasEvidence)
  }
}

/**
 * Before a wake clears the shared marker, the copies not woken get per-tab fences, so waking one
 * copy of a twin never re-arms another. `wokenHostId` null wakes no copy but `exceptTabIds`.
 */
export function fenceTwinCopiesBeforeSharedWake(
  state: AppState,
  worktreeId: string,
  wokenHostId: ExecutionHostId | null,
  exceptTabIds: readonly string[] = []
): void {
  if (!hasWorktreeSleepIntent(worktreeId)) {
    return
  }
  const hostIds = listWorkspacePublisherHostIds(state, worktreeId)
  if (hostIds.length < 2) {
    return
  }
  const owners = collectTerminalTabOwners(state, worktreeId, hostIds)
  for (const hostId of hostIds) {
    if (hostId !== wokenHostId) {
      const fenced = [...tabsOwnedBy(owners, hostId)].filter((id) => !exceptTabIds.includes(id))
      markCopySleepIntent(worktreeId, hostId, fenced)
    }
  }
}

/** The host a terminal tab of a twin belongs to, when exactly one can claim it. */
export function resolveTwinTerminalTabHost(
  state: AppState,
  worktreeId: string,
  tabId: string
): ExecutionHostId | null {
  const hostIds = listWorkspacePublisherHostIds(state, worktreeId)
  return hostIds.length < 2
    ? null
    : (collectTerminalTabOwners(state, worktreeId, hostIds).ownerByTabId.get(tabId) ?? null)
}

/**
 * The target names the host, so nothing is ambiguous unless its attributed panes are runtime PTYs:
 * a paired runtime's SSH copy runs them there, and each id names its runtime.
 */
export function resolveHostTwinTeardownOwner(
  scope: HostTwinTerminalScope,
  ptyIds: readonly string[],
  options: { backendOwnsPtyTeardown: boolean; unattributedTabs: UnattributedTabPolicy }
): TerminalTeardownOwner {
  if (options.backendOwnsPtyTeardown) {
    return { kind: 'resolved', runtimeEnvironmentId: scope.runtimeEnvironmentId }
  }
  // Why: a split tab shared with the twin can't lose only some panes here, so nothing is stopped.
  if (
    scope.ownerAmbiguous ||
    scope.mixedTabPtyIds.size > 0 ||
    (scope.unattributedTabIds.size > 0 && options.unattributedTabs === 'refuse')
  ) {
    return { kind: 'refused', reason: 'ambiguous_terminal_owner' }
  }
  // Why: with no bound PTY a hinted shell may still run on its host; no binding proves no death.
  if (ptyIds.length === 0 && scope.hasPtyEvidence && !scope.runtimeEnvironmentId) {
    return { kind: 'refused', reason: 'ambiguous_terminal_owner' }
  }
  if (scope.runtimeEnvironmentId || !ptyIds.some(isRemoteRuntimePtyId)) {
    return { kind: 'resolved', runtimeEnvironmentId: scope.runtimeEnvironmentId }
  }
  return resolveTerminalTeardownOwner({ kind: 'ambiguous' }, ptyIds)
}

/**
 * Tabs no copy can claim: refuse (one copy sleeps alone), skip (another copy in the same batch
 * stops them) or stop (the batch's last copy, as a raw id would).
 */
export type UnattributedTabPolicy = 'refuse' | 'skip' | 'stop'

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
