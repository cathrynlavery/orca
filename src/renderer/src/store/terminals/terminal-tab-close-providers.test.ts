import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { createTestStore } from '../slices/store-test-helpers'
import { makeFolderWorkspace } from '../slices/worktrees-slice-test-fixtures'
import { startTerminalTabProviderRetirement } from './terminal-tab-close-providers'

const callRuntimeRpc = vi.hoisted(() => vi.fn().mockResolvedValue({}))

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
  it('skips the close when two hosts publish the workspace', () => {
    const store = createTestStore()
    const workspaceKey = folderWorkspaceKey('folder-1')
    store.setState(() => ({
      folderWorkspaces: [
        makeFolderWorkspace({ id: 'folder-1', folderPath: '/work/f', executionHostId: 'local' }),
        makeFolderWorkspace({
          id: 'folder-1',
          folderPath: '/work/f',
          executionHostId: 'runtime:env-b'
        })
      ]
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

    // The legacy id names neither copy's server, so neither is asked to close it.
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })
})
