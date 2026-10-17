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
import { createHostTwinFixture, type HostTwinFixture } from './host-twin.test-fixture'

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
const runtimeCall = vi.fn((args: RuntimeEnvironmentCallRequest) => {
  const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
  if (compatible) {
    return compatible
  }
  const result =
    args.method === 'terminal.sleep'
      ? { stopped: 1, stoppedPtyIds: [], livePtyIds: [], postStopVerified: true }
      : {}
  return { id: args.method, ok: true, result, _meta: { runtimeId: 'runtime-b' } }
})
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
  runtimeCall.mockClear()
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
})
