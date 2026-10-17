import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../runtime/runtime-rpc-client'
import {
  clearWorktreeSleepIntent,
  hasPaneSleepIntent,
  hasWorktreeSleepIntent,
  markCopySleepIntent
} from '@/lib/worktree-sleep-intent'
import { resetHostTwinModuleStores } from './host-twin-state-projection.test-fixture'
import {
  createHostTwinFixture,
  TWIN_RUNTIME_ENV,
  type HostTwinFixture
} from './host-twin.test-fixture'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { listWorkspacePublisherHostIds } from './slices/worktrees/teardown/host-twin-worktree-purge'

const appStore = vi.hoisted((): { current: HostTwinFixture['store'] | null } => ({
  current: null
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => {
      if (!appStore.current) {
        throw new Error('no twin fixture store bound')
      }
      return appStore.current.getState()
    }
  }
}))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

const { sleepWorktreesReportingFailures } = await import('@/components/sidebar/sleep-worktree-flow')

const ptyKill = vi.fn()
function answerLikeHost(args: RuntimeEnvironmentCallRequest): unknown {
  const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
  if (compatible) {
    return compatible
  }
  const result =
    args.method === 'terminal.sleep'
      ? { stopped: 1, stoppedPtyIds: [], livePtyIds: [], postStopVerified: true }
      : {}
  return { id: args.method, ok: true, result, _meta: { runtimeId: 'runtime-b' } }
}
const runtimeCall = vi.fn(answerLikeHost)
const shutdownBrowsers = vi.fn()

let current: HostTwinFixture | null = null

function twin(kind: Parameters<typeof createHostTwinFixture>[0] = 'local+ssh'): HostTwinFixture {
  const fixture = createHostTwinFixture(kind)
  current = fixture
  appStore.current = fixture.store
  fixture.store.setState({ shutdownWorktreeBrowsers: shutdownBrowsers })
  clearWorktreeSleepIntent(fixture.workspaceKey)
  return fixture
}

/** Adds a terminal tab under the twin's shared id, copying an existing row's shape. */
function addTab(f: HostTwinFixture, id: string, ptyId: string): void {
  f.store.setState((s) => {
    const tabs = s.tabsByWorktree[f.workspaceKey] ?? []
    return {
      tabsByWorktree: { [f.workspaceKey]: [...tabs, { ...tabs[0], id, ptyId }] },
      ptyIdsByTabId: { ...s.ptyIdsByTabId, [id]: [ptyId] }
    }
  })
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  ptyKill.mockReset()
  runtimeCall.mockReset()
  runtimeCall.mockImplementation(answerLikeHost)
  shutdownBrowsers.mockReset()
  vi.stubGlobal('window', {
    api: {
      pty: { kill: ptyKill },
      gh: { enqueuePRRefresh: vi.fn().mockResolvedValue(undefined) },
      runtimeEnvironments: { call: runtimeCall, list: vi.fn().mockResolvedValue([]) },
      ui: { set: vi.fn().mockResolvedValue(undefined) }
    }
  })
})

afterEach(() => {
  if (current) {
    resetHostTwinModuleStores(current)
  }
  current = null
  appStore.current = null
  vi.unstubAllGlobals()
})

const killedPtyIds = () => ptyKill.mock.calls.map(([ptyId]) => ptyId)
const both = (f: HostTwinFixture) => [
  hostWorktreeTarget({ id: f.workspaceKey, ...f.local }),
  hostWorktreeTarget({ id: f.workspaceKey, ...f.remote })
]

/** A local tab with no host stamp whose second pane runs on the runtime copy. */
function splitLocalTabAcrossCopies(f: HostTwinFixture): void {
  const tabId = f.local.terminalTabId
  f.store.setState((s) => ({
    ptyIdsByTabId: { ...s.ptyIdsByTabId, [tabId]: [f.local.ptyId, f.remote.ptyId] },
    unifiedTabsByWorktree: {
      [f.workspaceKey]: (s.unifiedTabsByWorktree[f.workspaceKey] ?? []).map((tab) =>
        tab.id === tabId ? { ...tab, executionHostId: undefined } : tab
      )
    }
  }))
}

/** A local tab with no host stamp split over two local panes. */
function unstampSplitLocalTab(f: HostTwinFixture): void {
  const tabId = f.local.terminalTabId
  f.store.setState((s) => ({
    ptyIdsByTabId: { ...s.ptyIdsByTabId, [tabId]: [f.local.ptyId, 'pty-local-2'] },
    terminalLayoutsByTabId: {
      ...s.terminalLayoutsByTabId,
      [tabId]: {
        ...s.terminalLayoutsByTabId[tabId],
        ptyIdsByLeafId: { 'leaf-1': f.local.ptyId, 'leaf-2': 'pty-local-2' }
      }
    },
    unifiedTabsByWorktree: {
      [f.workspaceKey]: (s.unifiedTabsByWorktree[f.workspaceKey] ?? []).map((tab) =>
        tab.id === tabId ? { ...tab, executionHostId: undefined } : tab
      )
    }
  }))
}

describe('per-tab sleep fences of a twin', () => {
  it('reopening a slept copy clears the fence of a tab its sleep stopped attributing', async () => {
    const f = twin('local+runtime')
    const tabId = f.local.terminalTabId
    f.store.setState((s) => ({
      ptyIdsByTabId: { ...s.ptyIdsByTabId, [tabId]: [f.local.ptyId, 'pty-local-2'] },
      terminalLayoutsByTabId: {
        ...s.terminalLayoutsByTabId,
        [tabId]: {
          ...s.terminalLayoutsByTabId[tabId],
          ptyIdsByLeafId: { 'leaf-1': f.local.ptyId, 'leaf-2': 'pty-local-2' }
        }
      },
      // No unified stamp: only the live, unprefixed ids name this tab's host.
      unifiedTabsByWorktree: {
        [f.workspaceKey]: (s.unifiedTabsByWorktree[f.workspaceKey] ?? []).map((tab) =>
          tab.id === tabId ? { ...tab, executionHostId: undefined } : tab
        )
      }
    }))

    const outcome = await sleepWorktreesReportingFailures([
      hostWorktreeTarget({ id: f.workspaceKey, ...f.local })
    ])
    expect(outcome.failedWorktreeIds).toEqual([])
    expect(hasPaneSleepIntent(f.workspaceKey, tabId)).toBe(true)

    f.store.getState().setActiveWorktree(f.workspaceKey, 'local')

    expect(hasPaneSleepIntent(f.workspaceKey, tabId)).toBe(false)
  })

  it('a batch naming both copies stops a tab neither copy can claim', async () => {
    const f = twin()
    addTab(f, 'tab-unclaimed', 'pty-x')

    const outcome = await sleepWorktreesReportingFailures(both(f))

    expect(outcome.failedWorktreeIds).toEqual([])
    expect(killedPtyIds()).toContain('pty-x')
  })

  it('a shell bind after both copies slept wakes only its own copy', async () => {
    const f = twin()
    await sleepWorktreesReportingFailures(both(f))
    expect(hasWorktreeSleepIntent(f.workspaceKey)).toBe(true)

    f.store.getState().updateTabPtyId(f.local.terminalTabId, f.local.ptyId)

    expect(hasPaneSleepIntent(f.workspaceKey, f.local.terminalTabId)).toBe(false)
    expect(hasPaneSleepIntent(f.workspaceKey, f.remote.terminalTabId)).toBe(true)
  })

  it('fences a tab the copy gained while an earlier target was still stopping', async () => {
    const f = twin()
    shutdownBrowsers.mockImplementation(async () => {
      addTab(f, 'tab-late', 'ssh:conn-b@@late')
      f.store.setState((s) => ({
        unifiedTabsByWorktree: {
          [f.workspaceKey]: [
            ...(s.unifiedTabsByWorktree[f.workspaceKey] ?? []),
            {
              ...(s.unifiedTabsByWorktree[f.workspaceKey] ?? [])[0],
              id: 'tab-late',
              entityId: 'tab-late',
              executionHostId: f.remote.hostId
            }
          ]
        }
      }))
    })

    await sleepWorktreesReportingFailures([
      'other-worktree',
      hostWorktreeTarget({ id: f.workspaceKey, ...f.remote })
    ])

    expect(hasPaneSleepIntent(f.workspaceKey, 'tab-late')).toBe(true)
  })

  it('fences the selected copy before it is deselected', async () => {
    const f = twin()
    f.store.getState().setActiveWorktree(f.workspaceKey, f.remote.hostId)
    const setActive = f.store.getState().setActiveWorktree
    let fencedWhenDeselected: boolean | null = null
    f.store.setState({
      setActiveWorktree: (id, ...rest) => {
        if (id === null) {
          fencedWhenDeselected = hasPaneSleepIntent(f.workspaceKey, f.remote.terminalTabId)
        }
        return setActive(id, ...rest)
      }
    })

    await sleepWorktreesReportingFailures([hostWorktreeTarget({ id: f.workspaceKey, ...f.remote })])

    expect(fencedWhenDeselected).toBe(true)
  })

  it("a fenced tab's exit does not count as activity", () => {
    const f = twin()
    const bump = vi.fn()
    f.store.setState({ bumpWorktreeActivity: bump })
    markCopySleepIntent(f.workspaceKey, f.remote.hostId, [f.remote.terminalTabId])

    f.store.getState().clearTabPtyId(f.remote.terminalTabId, f.remote.ptyId)

    expect(bump).not.toHaveBeenCalled()
  })

  it('a purge forgets the fences of the tabs it drops', () => {
    const f = twin()
    markCopySleepIntent(f.workspaceKey, f.remote.hostId, [f.remote.terminalTabId])

    f.store
      .getState()
      .purgeWorktreeTerminalState([hostWorktreeTarget({ id: f.workspaceKey, ...f.remote })])

    expect(hasPaneSleepIntent(f.workspaceKey, f.remote.terminalTabId)).toBe(false)
  })

  it('leaves an unclaimed tab running when an earlier copy of the batch failed to stop', async () => {
    const f = twin()
    addTab(f, 'tab-unclaimed', 'pty-x')
    ptyKill.mockImplementation((ptyId: string) => {
      if (ptyId === f.local.ptyId) {
        throw new Error('terminal_kill_failed')
      }
    })

    const outcome = await sleepWorktreesReportingFailures(both(f))

    expect(outcome.failedWorktreeIds).toEqual([f.workspaceKey])
    expect(killedPtyIds()).not.toContain('pty-x')
  })

  it('reopening one copy after an every-copy sleep remounts its unstamped split tab', async () => {
    const f = twin('local+runtime')
    const tabId = f.local.terminalTabId
    f.store.setState((s) => ({
      ptyIdsByTabId: { ...s.ptyIdsByTabId, [tabId]: [f.local.ptyId, 'pty-local-2'] },
      terminalLayoutsByTabId: {
        ...s.terminalLayoutsByTabId,
        [tabId]: {
          ...s.terminalLayoutsByTabId[tabId],
          ptyIdsByLeafId: { 'leaf-1': f.local.ptyId, 'leaf-2': 'pty-local-2' }
        }
      },
      unifiedTabsByWorktree: {
        [f.workspaceKey]: (s.unifiedTabsByWorktree[f.workspaceKey] ?? []).map((tab) =>
          tab.id === tabId ? { ...tab, executionHostId: undefined } : tab
        )
      }
    }))
    await sleepWorktreesReportingFailures(both(f))
    const generation = () =>
      f.store.getState().tabsByWorktree[f.workspaceKey]?.find((tab) => tab.id === tabId)
        ?.generation ?? 0
    const before = generation()

    f.store.getState().setActiveWorktree(f.workspaceKey, 'local')

    expect(generation()).toBe(before + 1)
    expect(hasPaneSleepIntent(f.workspaceKey, tabId)).toBe(false)
    expect(hasPaneSleepIntent(f.workspaceKey, f.remote.terminalTabId)).toBe(true)
  })

  it("drops a unified-only terminal's agent state when its copy is stopped", async () => {
    const f = twin()
    f.store.setState((s) => ({
      unifiedTabsByWorktree: {
        [f.workspaceKey]: [
          ...(s.unifiedTabsByWorktree[f.workspaceKey] ?? []),
          {
            ...(s.unifiedTabsByWorktree[f.workspaceKey] ?? [])[0],
            id: 'tab-unified-only',
            entityId: 'tab-unified-only',
            executionHostId: f.remote.hostId
          }
        ]
      },
      acknowledgedAgentsByPaneKey: { 'tab-unified-only:leaf-1': 1 }
    }))

    await f.store
      .getState()
      .shutdownWorktreeTerminals(hostWorktreeTarget({ id: f.workspaceKey, ...f.remote }))

    expect(
      f.store.getState().acknowledgedAgentsByPaneKey['tab-unified-only:leaf-1']
    ).toBeUndefined()
  })

  it('a later copy that fails to stop in an every-copy batch is left unfenced', async () => {
    const f = twin()
    ptyKill.mockImplementation((ptyId: string) => {
      if (ptyId === f.remote.ptyId) {
        throw new Error('terminal_kill_failed')
      }
    })

    await sleepWorktreesReportingFailures(both(f))

    expect(hasPaneSleepIntent(f.workspaceKey, f.remote.terminalTabId)).toBe(false)
    expect(hasPaneSleepIntent(f.workspaceKey, f.local.terminalTabId)).toBe(true)
  })

  it('opening a copy after an every-copy sleep remounts a tab neither copy claims', async () => {
    const f = twin()
    addTab(f, 'tab-unclaimed', 'pty-x')
    await sleepWorktreesReportingFailures(both(f))
    const generation = () =>
      f.store.getState().tabsByWorktree[f.workspaceKey]?.find((tab) => tab.id === 'tab-unclaimed')
        ?.generation ?? 0
    const before = generation()

    f.store.getState().setActiveWorktree(f.workspaceKey, f.local.hostId)

    expect(generation()).toBe(before + 1)
  })

  it("opening the other copy keeps a slept copy's unclaimed split tab fenced", async () => {
    const f = twin('local+runtime')
    const tabId = f.local.terminalTabId
    f.store.setState((s) => ({
      ptyIdsByTabId: { ...s.ptyIdsByTabId, [tabId]: [f.local.ptyId, 'pty-local-2'] },
      terminalLayoutsByTabId: {
        ...s.terminalLayoutsByTabId,
        [tabId]: {
          ...s.terminalLayoutsByTabId[tabId],
          ptyIdsByLeafId: { 'leaf-1': f.local.ptyId, 'leaf-2': 'pty-local-2' }
        }
      },
      unifiedTabsByWorktree: {
        [f.workspaceKey]: (s.unifiedTabsByWorktree[f.workspaceKey] ?? []).map((tab) =>
          tab.id === tabId ? { ...tab, executionHostId: undefined } : tab
        )
      }
    }))
    await sleepWorktreesReportingFailures([hostWorktreeTarget({ id: f.workspaceKey, ...f.local })])

    f.store.getState().setActiveWorktree(f.workspaceKey, f.remote.hostId)

    expect(hasPaneSleepIntent(f.workspaceKey, tabId)).toBe(true)
  })

  it('a copy opened while an every-copy batch stops the other ends up awake', async () => {
    const f = twin()
    ptyKill.mockImplementation((ptyId: string) => {
      if (ptyId === f.remote.ptyId) {
        f.store.getState().setActiveWorktree(f.workspaceKey, f.local.hostId)
      }
    })

    await sleepWorktreesReportingFailures(both(f))

    expect(hasPaneSleepIntent(f.workspaceKey, f.local.terminalTabId)).toBe(false)
    expect(hasPaneSleepIntent(f.workspaceKey, f.remote.terminalTabId)).toBe(true)
  })

  it('closing a fenced tab forgets its fence', () => {
    const f = twin()
    markCopySleepIntent(f.workspaceKey, f.remote.hostId, [f.remote.terminalTabId])

    f.store.getState().closeTab(f.remote.terminalTabId, { reason: 'cleanup' })

    expect(hasPaneSleepIntent(f.workspaceKey, f.remote.terminalTabId)).toBe(false)
  })

  it('a batch naming both copies sleeps a split tab that spans them', async () => {
    const f = twin('local+runtime')
    splitLocalTabAcrossCopies(f)

    const outcome = await sleepWorktreesReportingFailures(both(f))

    expect(outcome.failedWorktreeIds).toEqual([])
    expect(killedPtyIds()).toContain(f.local.ptyId)
  })

  it('a lone copy refused over a split tab says how to sleep it', async () => {
    const f = twin('local+runtime')
    splitLocalTabAcrossCopies(f)

    const outcome = await sleepWorktreesReportingFailures([
      hostWorktreeTarget({ id: f.workspaceKey, ...f.local })
    ])

    expect(outcome.errors).toEqual([expect.stringContaining('Sleep both copies together')])
  })

  it('a single-host worktree with a legacy unstamped row has one publisher', () => {
    const f = twin()
    // Only the SSH host owns the repo; its listing left an older, unstamped copy of the row.
    f.store.setState((s) => ({
      repos: s.repos.filter((repo) => repo.executionHostId === f.remote.hostId),
      worktreesByRepo: {
        [f.projectId]: (s.worktreesByRepo[f.projectId] ?? []).map((row) =>
          row.hostId === f.local.hostId ? { ...row, hostId: undefined } : row
        )
      }
    }))

    expect(listWorkspacePublisherHostIds(f.store.getState(), f.workspaceKey)).toEqual([
      f.remote.hostId
    ])
  })

  it('opening one copy after a raw-id sleep keeps the other copy fenced', async () => {
    const f = twin('local+runtime')
    unstampSplitLocalTab(f)

    await sleepWorktreesReportingFailures([f.workspaceKey])
    f.store.getState().setActiveWorktree(f.workspaceKey, f.remote.hostId)

    // The local tab lost the live ids that attributed it, yet it stays asleep with its copy.
    expect(hasPaneSleepIntent(f.workspaceKey, f.local.terminalTabId)).toBe(true)
    expect(hasPaneSleepIntent(f.workspaceKey, f.remote.terminalTabId)).toBe(false)
  })

  it("guards a split tab's runtime pane before the runtime copy's host-wide stop", async () => {
    const f = twin('local+runtime')
    const splitPty = toRemoteRuntimePtyId('handle-split', TWIN_RUNTIME_ENV)
    f.store.setState((s) => ({
      ptyIdsByTabId: { ...s.ptyIdsByTabId, [f.local.terminalTabId]: [f.local.ptyId, splitPty] },
      unifiedTabsByWorktree: {
        [f.workspaceKey]: (s.unifiedTabsByWorktree[f.workspaceKey] ?? []).map((tab) =>
          tab.id === f.local.terminalTabId ? { ...tab, executionHostId: undefined } : tab
        )
      }
    }))
    let guardedDuringHostStop: boolean | null = null
    runtimeCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'terminal.sleep' && guardedDuringHostStop === null) {
        guardedDuringHostStop = f.store.getState().isPtyShutdownPending(splitPty)
      }
      return answerLikeHost(args)
    })

    await sleepWorktreesReportingFailures(both(f).toReversed())

    expect(guardedDuringHostStop).toBe(true)
  })

  it('keeps local as a publisher beside a paired runtime SSH copy', () => {
    const f = twin()
    f.store.setState((s) => ({
      worktreesByRepo: {
        [f.projectId]: (s.worktreesByRepo[f.projectId] ?? []).map((row) =>
          row.hostId === f.remote.hostId
            ? { ...row, runtimeOwnerEnvironmentId: TWIN_RUNTIME_ENV }
            : row
        )
      }
    }))

    expect(listWorkspacePublisherHostIds(f.store.getState(), f.workspaceKey)).toContain(
      f.local.hostId
    )
  })

  it('the batch stops a split tab on its last copy without asking the runtime again', async () => {
    const f = twin('local+runtime')
    splitLocalTabAcrossCopies(f)

    const outcome = await sleepWorktreesReportingFailures(both(f).toReversed())

    expect(outcome.failedWorktreeIds).toEqual([])
    expect(killedPtyIds()).toContain(f.local.ptyId)
    const sleeps = runtimeCall.mock.calls.filter(([args]) => args.method === 'terminal.sleep')
    expect(sleeps).toHaveLength(1)
  })

  it("leaves a split tab's local pane unguarded when the runtime copy failed first", async () => {
    const f = twin('local+runtime')
    splitLocalTabAcrossCopies(f)
    runtimeCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'terminal.sleep') {
        throw new Error('runtime unavailable')
      }
      return answerLikeHost(args)
    })

    await sleepWorktreesReportingFailures(both(f).toReversed())

    expect(f.store.getState().suppressedPtyExitIds[f.local.ptyId]).toBeUndefined()
    expect(f.store.getState().isPtyShutdownPending(f.local.ptyId)).toBe(false)
  })

  it('opening one copy during a raw-id sleep leaves the other copy fenced', async () => {
    const f = twin()
    ptyKill.mockImplementation((ptyId: string) => {
      if (ptyId === f.local.ptyId) {
        f.store.getState().setActiveWorktree(f.workspaceKey, f.local.hostId)
      }
    })

    await sleepWorktreesReportingFailures([f.workspaceKey])

    expect(hasPaneSleepIntent(f.workspaceKey, f.local.terminalTabId)).toBe(false)
    expect(hasPaneSleepIntent(f.workspaceKey, f.remote.terminalTabId)).toBe(true)
  })

  it("captures a split tab's runtime agent before the runtime copy's stop exits it", async () => {
    const f = twin('local+runtime')
    const splitPty = toRemoteRuntimePtyId('handle-split', TWIN_RUNTIME_ENV)
    const paneKey = `${f.local.terminalTabId}:leaf-2`
    f.store.setState((s) => ({
      ptyIdsByTabId: { ...s.ptyIdsByTabId, [f.local.terminalTabId]: [f.local.ptyId, splitPty] },
      terminalLayoutsByTabId: {
        ...s.terminalLayoutsByTabId,
        [f.local.terminalTabId]: {
          ...s.terminalLayoutsByTabId[f.local.terminalTabId],
          ptyIdsByLeafId: { 'leaf-1': f.local.ptyId, 'leaf-2': splitPty }
        }
      },
      unifiedTabsByWorktree: {
        [f.workspaceKey]: (s.unifiedTabsByWorktree[f.workspaceKey] ?? []).map((tab) =>
          tab.id === f.local.terminalTabId ? { ...tab, executionHostId: undefined } : tab
        )
      },
      sleepingAgentSessionsByPaneKey: {},
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'working',
          prompt: 'p',
          updatedAt: 1,
          stateStartedAt: 1,
          paneKey,
          stateHistory: [],
          agentType: 'claude',
          worktreeId: f.workspaceKey,
          providerSession: { key: 'session_id', id: 'session-split' }
        }
      }
    }))

    // The runtime's stop exits the pane, whose exit drops its live agent row.
    runtimeCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'terminal.sleep') {
        f.store.setState({ agentStatusByPaneKey: {} })
      }
      return answerLikeHost(args)
    })

    await sleepWorktreesReportingFailures([
      hostWorktreeTarget({ id: f.workspaceKey, ...f.remote }),
      hostWorktreeTarget({ id: f.workspaceKey, ...f.local })
    ])

    expect(f.store.getState().sleepingAgentSessionsByPaneKey[paneKey]?.origin).toBe(
      'worktree-sleep'
    )
  })

  it('opening a copy during a repeated raw-id sleep wakes it once teardown ends', async () => {
    const f = twin('local+runtime')
    await sleepWorktreesReportingFailures([f.workspaceKey])
    shutdownBrowsers.mockImplementation(async () => {
      f.store.getState().setActiveWorktree(f.workspaceKey, f.local.hostId)
    })

    await sleepWorktreesReportingFailures([f.workspaceKey])

    expect(hasPaneSleepIntent(f.workspaceKey, f.local.terminalTabId)).toBe(false)
    expect(hasPaneSleepIntent(f.workspaceKey, f.remote.terminalTabId)).toBe(true)
  })

  it("a batch's last copy still stops an unclaimed pane on a server outside the twin", async () => {
    const f = twin()
    addTab(f, 'tab-env-c', toRemoteRuntimePtyId('handle-c', 'env-c'))

    await sleepWorktreesReportingFailures(both(f))

    const sleeps = runtimeCall.mock.calls.filter(([args]) => args.method === 'terminal.sleep')
    expect(sleeps).toHaveLength(1)
  })
})
