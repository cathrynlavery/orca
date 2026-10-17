import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  clearTabSleepIntent,
  clearWorktreeSleepIntent,
  hasPaneSleepIntent,
  markCopySleepIntent,
  markWorktreeSleepIntent,
  withTabSleepTeardown,
  withWorktreeSleepTeardown
} from '@/lib/worktree-sleep-intent'
import { VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } from '@/hooks/useVirtualizedScrollAnchor'
import { translate } from '@/i18n/i18n'
import { resolveHostTwinTerminalScope } from '@/store/terminals/host-twin-terminal-scope'
import {
  planIsSelectedCopy,
  planWorktreeSleep,
  type SleepWorktreeTarget,
  type WorktreeSleepPlan
} from './sleep-worktree-plan'

export type { SleepWorktreeTarget } from './sleep-worktree-plan'

/**
 * Shared "sleep worktree" flow (close all panels to free memory / CPU)
 * used by WorktreeContextMenu and MemoryStatusSegment's per-row hover action.
 *
 * Why this is a module helper rather than inlined at each call site: the guard
 * that clears `activeWorktreeId` before tearing down terminals isn't optional
 * polish — shutting down the active worktree while its TerminalPane is still
 * visible causes a visible "reboot" flicker and can crash the pane (PTY exit
 * callbacks race against the live xterm instance). See the original comment
 * in WorktreeContextMenu's handleCloseTerminals for the full reasoning.
 * Centralizing the sequence here keeps that safety invariant in one place so
 * a new caller can't accidentally skip it.
 */
export async function runSleepWorktree(target: SleepWorktreeTarget): Promise<void> {
  await runSleepWorktrees([target])
}

function getSidebarWorktreeOptions(worktreeId: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-worktree-id]')).filter(
    (element) => element.dataset.worktreeId === worktreeId
  )
}

function isPinnedSidebarWorktreeOption(element: HTMLElement): boolean {
  // Why: duplicated pinned rows share a worktree id; the row-key prefix is the
  // stable row-scoped signal that distinguishes the pinned copy from natural rows.
  return element.dataset.worktreeRowKey?.startsWith('pinned:') === true
}

function findPrimarySidebarWorktreeOption(worktreeId: string): HTMLElement | null {
  const options = getSidebarWorktreeOptions(worktreeId)
  return (
    options.find((element) =>
      element.querySelector<HTMLElement>('[data-worktree-card-active="primary"]')
    ) ??
    options.find((element) => !isPinnedSidebarWorktreeOption(element)) ??
    options[0] ??
    null
  )
}

function findSidebarWorktreeRow(worktreeId: string, rowKey?: string): HTMLElement | null {
  const options = getSidebarWorktreeOptions(worktreeId)
  const option = rowKey
    ? (options.find((element) => element.dataset.worktreeRowKey === rowKey) ?? null)
    : (findPrimarySidebarWorktreeOption(worktreeId) ?? null)
  return option?.closest<HTMLElement>('[data-worktree-virtual-row]') ?? null
}

function preserveSidebarWorktreePosition(worktreeId: string): () => void {
  if (typeof document === 'undefined') {
    return () => {}
  }
  const getScroller = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-worktree-sidebar]')
  const scroller = getScroller()
  const activeOption = findPrimarySidebarWorktreeOption(worktreeId)
  const activeRowKey = activeOption?.dataset.worktreeRowKey
  const row = activeOption?.closest<HTMLElement>('[data-worktree-virtual-row]') ?? null
  if (!scroller || !row) {
    return () => {}
  }
  scroller.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
  const previousScrollTop = scroller.scrollTop
  const previousScrollHeight = scroller.scrollHeight
  const previousTop = row.getBoundingClientRect().top

  return () => {
    let attempts = 0
    const restore = (): void => {
      const currentScroller = getScroller()
      if (!currentScroller) {
        attempts += 1
        if (attempts < 12) {
          window.requestAnimationFrame(restore)
        }
        return
      }
      const nextRow = findSidebarWorktreeRow(worktreeId, activeRowKey)
      if (!nextRow) {
        // Why: a remount can first render the wrong virtual window. Put the
        // scroller near the same content after height changes so the row
        // mounts, then retry and correct by actual DOM position.
        currentScroller.scrollTop = Math.max(
          0,
          previousScrollTop + currentScroller.scrollHeight - previousScrollHeight
        )
      } else {
        const delta = nextRow.getBoundingClientRect().top - previousTop
        if (Math.abs(delta) > 1) {
          currentScroller.scrollTop += delta
        }
      }
      attempts += 1
      if (attempts < 12) {
        window.requestAnimationFrame(restore)
      }
    }
    window.requestAnimationFrame(restore)
  }
}

function describeSleepFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (detail.includes('legacy')) {
    return translate(
      'auto.components.sidebar.sleep.worktree.flow.legacy.unverified',
      'The older host runtime could not confirm terminal shutdown. The workspace was kept open; update the host and try again.'
    )
  }
  if (
    detail.includes('terminal_') ||
    detail.includes('runtime') ||
    detail.includes('connection') ||
    detail.includes('Daemon')
  ) {
    return translate(
      'auto.components.sidebar.sleep.worktree.flow.host.unverified',
      'The host could not confirm terminal shutdown. The workspace was kept open; check the connection and try again.'
    )
  }
  return translate(
    'auto.components.sidebar.sleep.worktree.flow.retry',
    'The workspace was kept open. Try again; if the problem continues, check the host connection.'
  )
}

export async function runSleepWorktrees(targets: readonly SleepWorktreeTarget[]): Promise<void> {
  const { errors } = await sleepWorktreesReportingFailures(targets)
  if (errors.length > 0) {
    // Why: callers are fire-and-forget; surface actionable teardown failures after restoring retryable UI state.
    toast.error(
      targets.length === 1
        ? translate(
            'auto.components.sidebar.sleep.worktree.flow.8bc3fc0671',
            'Failed to sleep workspace'
          )
        : translate(
            'auto.components.sidebar.sleep.worktree.flow.c460fecc4a',
            'Failed to sleep some workspaces'
          ),
      {
        description: errors.join('\n')
      }
    )
  }
}

export type WorktreeSleepOutcome = { failedWorktreeIds: string[]; errors: string[] }

/** The sleep without the toast, for callers that report failures themselves. */
export async function sleepWorktreesReportingFailures(
  targets: readonly SleepWorktreeTarget[]
): Promise<WorktreeSleepOutcome> {
  if (targets.length === 0) {
    return { failedWorktreeIds: [], errors: [] }
  }
  const {
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    setActiveWorktree,
    shutdownWorktreeBrowsers,
    shutdownWorktreeTerminals
  } = useAppStore.getState()
  const plans = planWorktreeSleep(useAppStore.getState(), targets)
  // Why per copy: a copy's tabs are read when it is reached, so a tab opened mid-batch is fenced.
  const fenceCopy = (plan: WorktreeSleepPlan): string[] => {
    const scope = resolveHostTwinTerminalScope(useAppStore.getState(), plan.target)
    if (!scope) {
      return []
    }
    const newlyFenced = [...scope.tabIds].filter(
      (tabId) => !hasPaneSleepIntent(plan.worktreeId, tabId)
    )
    markCopySleepIntent(plan.worktreeId, scope.copyHostId, scope.tabIds)
    return newlyFenced
  }
  const sleptActivePlan = plans.find((plan) =>
    planIsSelectedCopy(
      useAppStore.getState(),
      plan,
      activeWorktreeId,
      activeWorkspaceExecutionHostId
    )
  )
  const newlyFencedByPlan = new Map<WorktreeSleepPlan, string[]>()
  if (sleptActivePlan && activeWorktreeId) {
    const restoreSidebarPosition = preserveSidebarWorktreePosition(activeWorktreeId)
    // Why: clearing the active workspace can unmount TerminalPanes before
    // shutdownWorktreeTerminals writes PTY suppressions; mark first so those
    // exits do not stamp activity. Kept off the store so it cannot disturb the
    // sidebar's scroll restoration.
    if (sleptActivePlan.copyOnly || sleptActivePlan.everyCopy) {
      newlyFencedByPlan.set(sleptActivePlan, fenceCopy(sleptActivePlan))
    }
    if (!sleptActivePlan.copyOnly) {
      markWorktreeSleepIntent(activeWorktreeId)
    }
    setActiveWorktree(null)
    restoreSidebarPosition()
  }
  const errors: string[] = []
  const failedPlans = new Set<WorktreeSleepPlan>()
  const fail = (plan: WorktreeSleepPlan, err: unknown, step: string): void => {
    console.error(`[sleep-worktree] ${step} failed`, { worktreeId: plan.worktreeId, error: err })
    failedPlans.add(plan)
    errors.push(describeSleepFailure(err))
  }
  const hasFailed = (worktreeId: string): boolean =>
    [...failedPlans].some((plan) => plan.worktreeId === worktreeId)
  try {
    for (const plan of plans) {
      const { target, worktreeId, copyOnly } = plan
      // Why: the marker outlives teardown so the panes left mounted stay cold
      // until an explicit wake (#10205); mark per workspace so an earlier
      // slow teardown never leaves a later, still-awake one marked.
      // Why per copy for every-copy batches too: its sleep removes the PTY evidence that
      // attributes some tabs, so reopening one copy must find exactly what it fenced.
      if (copyOnly || plan.everyCopy) {
        newlyFencedByPlan.set(plan, [...(newlyFencedByPlan.get(plan) ?? []), ...fenceCopy(plan)])
      }
      if (!copyOnly) {
        markWorktreeSleepIntent(worktreeId)
      }
      try {
        // Why: sleep mirrors removeWorktree's shutdown sequence — browsers first
        // so destroyPersistentWebview unregisters the Chromium guests before any
        // other teardown runs, terminals second so the PTY kill uses the same
        // ordering on both paths. Without the browser thunk here, sleep leaks
        // browserPagesByWorkspace entries and live webviews for the slept worktree.
        if (plan.ownsSharedBrowsers) {
          await withWorktreeSleepTeardown(worktreeId, () => shutdownWorktreeBrowsers(worktreeId))
        }
      } catch (err) {
        fail(plan, err, 'browser shutdown')
        continue
      }
      try {
        // Why: sleep is reversible — the tab record stays in tabsByWorktree, the
        // layout stays in terminalLayoutsByTabId, only the live PTY processes are
        // released. keepIdentifiers preserves tab.ptyId / ptyIdsByLeafId /
        // lastKnownRelayPtyIdByTabId so wake re-spawns against the same on-disk
        // history dir (local) or relay session id (SSH); it also captures
        // serializer buffers into buffersByLeafId for SSH wake to reseed
        // scrollback. See DESIGN_DOC_TERMINAL_HISTORY_FIX_V2.md §3.3.c.
        const teardown = async (): Promise<void> => {
          await shutdownWorktreeTerminals(target, {
            keepIdentifiers: true,
            // Why skip after a failure: an unclaimed tab may be the failed copy's, still running.
            ...(plan.everyCopy
              ? {
                  unattributedTabs:
                    plan.unattributedTabs === 'stop' && hasFailed(worktreeId)
                      ? 'skip'
                      : plan.unattributedTabs
                }
              : {})
          })
          if (
            plan.suspendsSharedVm &&
            !hasFailed(worktreeId) &&
            typeof window !== 'undefined' &&
            window.api?.ephemeralVm?.suspendWorkspace
          ) {
            await window.api.ephemeralVm.suspendWorkspace({ workspaceId: worktreeId })
          }
        }
        // Why tab-scoped for one copy: a wake of the other copy during this teardown still counts.
        await (copyOnly
          ? withTabSleepTeardown(
              resolveHostTwinTerminalScope(useAppStore.getState(), target)?.tabIds ?? [],
              teardown
            )
          : withWorktreeSleepTeardown(worktreeId, teardown))
        // Why: a workspace the user activated during the batch is awake by their choice.
        const now = useAppStore.getState()
        if (
          planIsSelectedCopy(now, plan, now.activeWorktreeId, now.activeWorkspaceExecutionHostId)
        ) {
          if (newlyFencedByPlan.has(plan)) {
            clearTabSleepIntent(worktreeId, newlyFencedByPlan.get(plan) ?? [])
          }
          if (!copyOnly) {
            clearWorktreeSleepIntent(worktreeId)
          }
        }
      } catch (err) {
        fail(plan, err, 'terminal or host suspension')
      }
    }
  } finally {
    // Why: a failed sleep leaves the workspace awake and retryable.
    for (const plan of failedPlans) {
      // Why only new fences: a failed repeat sleep must not wake a copy that is already asleep.
      if (newlyFencedByPlan.has(plan)) {
        clearTabSleepIntent(plan.worktreeId, newlyFencedByPlan.get(plan) ?? [])
      }
      // Why: copies of an every-copy batch that did sleep keep their per-copy fences.
      if (!plan.copyOnly) {
        clearWorktreeSleepIntent(plan.worktreeId)
      }
    }
    if (sleptActivePlan && activeWorktreeId && failedPlans.has(sleptActivePlan)) {
      const { target } = sleptActivePlan
      if (typeof target !== 'string' && (sleptActivePlan.copyOnly || sleptActivePlan.everyCopy)) {
        setActiveWorktree(activeWorktreeId, target.hostId)
      } else {
        setActiveWorktree(activeWorktreeId)
      }
    }
  }
  return {
    failedWorktreeIds: [...new Set([...failedPlans].map((plan) => plan.worktreeId))],
    errors
  }
}
