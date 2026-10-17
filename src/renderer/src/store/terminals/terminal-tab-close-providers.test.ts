import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { createTestStore } from '../slices/store-test-helpers'
import { makeFolderWorkspace } from '../slices/worktrees-slice-test-fixtures'
import { startTerminalTabProviderRetirement } from './terminal-tab-close-providers'

const callRuntimeRpc = vi.hoisted(() => vi.fn().mockResolvedValue({}))

// Why: stands in for exactly one focused server, the guess teardown must not act on.
vi.mock('@/lib/single-runtime-legacy-owner', () => ({
  getSingleFocusedRuntimeEnvironmentId: () => 'env-focused'
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc,
  ensureRuntimeEnvironmentCompatible: vi.fn().mockResolvedValue(undefined)
}))

beforeEach(() => {
  callRuntimeRpc.mockClear()
  vi.stubGlobal('window', { api: { pty: { kill: vi.fn() } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('provider retirement of a legacy runtime terminal', () => {
  it('skips an unowned close instead of guessing a host', () => {
    const store = createTestStore()
    const workspaceKey = folderWorkspaceKey('folder-1')
    store.setState(() => ({
      folderWorkspaces: [makeFolderWorkspace({ id: 'folder-1', folderPath: '/work/f' })]
    }))

    startTerminalTabProviderRetirement({
      localPtyTeardownOwnedExternally: true,
      remoteCloseOwnedByHost: false,
      retirementPlan: {
        tabId: 'tab-1',
        worktreeId: workspaceKey,
        ptyIds: ['remote:handle-1'],
        localOrSshPtyIds: [],
        runtimeTerminals: [{ ptyId: 'remote:handle-1', handle: 'handle-1', environmentId: null }],
        cleanupOnlyPtyIds: [],
        sharedPtyIds: [],
        unroutablePtyIds: []
      },
      state: store.getState(),
      tabId: 'tab-1'
    })

    // Neither the focused server nor this machine's runtime is proven to hold the handle.
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })
})
