import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../runtime/runtime-rpc-client'
import { hasWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { resetHostTwinModuleStores } from './host-twin-state-projection.test-fixture'
import {
  createHostTwinFixture,
  TWIN_RUNTIME_ENV,
  type HostTwinFixture
} from './host-twin.test-fixture'

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
const runtimeCall = vi.fn((args: RuntimeEnvironmentCallRequest & { selector?: string }) => {
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
  return fixture
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  ptyKill.mockReset()
  runtimeCall.mockClear()
  shutdownBrowsers.mockReset()
  vi.stubGlobal('window', {
    api: {
      pty: { kill: ptyKill },
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

describe('kill and sleep on one host of a twin', () => {
  it("stops only the target host's terminals", async () => {
    const f = twin()

    await f.store
      .getState()
      .shutdownWorktreeTerminals(hostWorktreeTarget({ id: f.workspaceKey, ...f.remote }))

    expect(killedPtyIds()).toEqual([f.remote.ptyId])
    expect(f.store.getState().ptyIdsByTabId[f.local.terminalTabId]).toEqual([f.local.ptyId])
    expect(f.store.getState().ptyIdsByTabId[f.remote.terminalTabId]).toEqual([])
  })

  it('keeps stopping both copies for a raw id, as before', async () => {
    const f = twin()

    await f.store.getState().shutdownWorktreeTerminals(f.workspaceKey)

    expect(killedPtyIds().sort()).toEqual([f.local.ptyId, f.remote.ptyId].sort())
  })

  it("sends a runtime target's stop to that runtime only", async () => {
    const f = twin('local+runtime')

    await f.store
      .getState()
      .shutdownWorktreeTerminals(hostWorktreeTarget({ id: f.workspaceKey, ...f.remote }))

    const stops = runtimeCall.mock.calls.filter(([args]) => args.method === 'terminal.stop')
    expect(stops.map(([args]) => args.selector)).toEqual([TWIN_RUNTIME_ENV])
    // The RPC params are today's: the host learns nothing new.
    expect(Object.keys(stops[0]?.[0].params ?? {})).toEqual(['worktree'])
    expect(killedPtyIds()).not.toContain(f.local.ptyId)
  })

  it('sleeps one copy without touching the shared marker or browsers', async () => {
    const f = twin()

    const outcome = await sleepWorktreesReportingFailures([
      hostWorktreeTarget({ id: f.workspaceKey, ...f.remote })
    ])

    expect(outcome.failedWorktreeIds).toEqual([])
    expect(killedPtyIds()).toEqual([f.remote.ptyId])
    // The fixture marks it for both copies; the awake one still owns it.
    expect(hasWorktreeSleepIntent(f.workspaceKey)).toBe(true)
    expect(shutdownBrowsers).not.toHaveBeenCalled()
    expect(f.store.getState().sleepingAgentSessionsByPaneKey[f.local.paneKey]).toBeDefined()
  })

  it('sleeps the whole worktree for a host target with no twin, as before', async () => {
    const f = twin()
    f.store.setState((s) => ({
      worktreesByRepo: {
        [f.projectId]: (s.worktreesByRepo[f.projectId] ?? []).filter(
          (row) => row.hostId === f.local.hostId
        )
      }
    }))

    await sleepWorktreesReportingFailures([hostWorktreeTarget({ id: f.workspaceKey, ...f.local })])

    expect(killedPtyIds().sort()).toEqual([f.local.ptyId, f.remote.ptyId].sort())
    expect(shutdownBrowsers).toHaveBeenCalledWith(f.workspaceKey)
  })
})
