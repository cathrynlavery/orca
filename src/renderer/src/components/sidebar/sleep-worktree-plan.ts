import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { isExecutionHostAliasForWorktree } from '@/lib/worktree-execution-host-alias'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import {
  collectFullyTargetedTwinIds,
  resolveHostTwinTerminalScope,
  worktreeIdOfTarget,
  type UnattributedTabPolicy
} from '@/store/terminals/host-twin-terminal-scope'

/** A raw id sleeps the whole worktree; a host target sleeps only that host's copy of a twin. */
export type SleepWorktreeTarget = string | HostWorktreeTarget

/** How one target of a batch sleeps, decided once before any teardown. */
export type WorktreeSleepPlan = {
  target: SleepWorktreeTarget
  worktreeId: string
  /**
   * Only this host's copy sleeps while another stays awake. The raw-id marker, browsers and VM
   * then belong to the awake copy too, so this copy is fenced per tab instead: the shared marker
   * would hold the awake copy's connects, and its next bind would re-arm this copy's panes.
   */
  copyOnly: boolean
  /** The batch names every copy of the id, so the shared raw-id state sleeps with it. */
  everyCopy: boolean
  /** The first plan for its id owns the shared browser teardown. */
  ownsSharedBrowsers: boolean
  /** The last plan for its id suspends the VM, whose transport the other copies still need. */
  suspendsSharedVm: boolean
  unattributedTabs: UnattributedTabPolicy
}

export function planWorktreeSleep(
  state: AppState,
  targets: readonly SleepWorktreeTarget[]
): WorktreeSleepPlan[] {
  const everyCopyIds = collectFullyTargetedTwinIds(state, targets)
  const firstIndexById = new Map<string, number>()
  const lastIndexById = new Map<string, number>()
  for (const [index, target] of targets.entries()) {
    const id = worktreeIdOfTarget(target)
    if (!firstIndexById.has(id)) {
      firstIndexById.set(id, index)
    }
    lastIndexById.set(id, index)
  }
  return targets.map((target, index) => {
    const worktreeId = worktreeIdOfTarget(target)
    const everyCopy = everyCopyIds.has(worktreeId)
    const copyOnly = !everyCopy && resolveHostTwinTerminalScope(state, target) !== null
    const isLast = index === lastIndexById.get(worktreeId)
    return {
      target,
      worktreeId,
      copyOnly,
      everyCopy,
      ownsSharedBrowsers: !copyOnly && index === firstIndexById.get(worktreeId),
      suspendsSharedVm: !copyOnly && isLast,
      // Why: with every copy named, tabs no copy claims go with the last copy, as a raw id would.
      unattributedTabs: everyCopy ? (isLast ? 'stop' : 'skip') : 'refuse'
    }
  })
}

/** Whether a plan's copy is the one selected under `hostId`, through a paired runtime's alias. */
export function planIsSelectedCopy(
  state: AppState,
  plan: WorktreeSleepPlan,
  activeWorktreeId: string | null,
  activeHostId: ExecutionHostId | null
): boolean {
  if (plan.worktreeId !== activeWorktreeId) {
    return false
  }
  if (!plan.copyOnly && !plan.everyCopy) {
    return true
  }
  const { target } = plan
  if (typeof target === 'string' || !activeHostId) {
    return false
  }
  const row = findKnownWorktreeById(state, target.worktreeId, target.hostId)
  return (
    target.hostId === activeHostId ||
    (row ? isExecutionHostAliasForWorktree(activeHostId, row) : false)
  )
}
