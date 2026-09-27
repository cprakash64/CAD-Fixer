import { useCallback } from 'react';
import { useWorkspaceStore } from '../../state/store-context';
import { WORKFLOWS, WorkflowId } from '../../state/workflows';
import { useShellLayout } from './shell-layout';
import { isWorkspaceAvailable } from './workspaces';

/**
 * "Export" everywhere in the product means: go to the Convert workspace.
 *
 * ONE ROUTE FOR EVERY ENTRY POINT — the top bar's Export, the inspector's
 * Export / Convert, the workspace tabs and the compact switcher — so none of
 * them can open a different conversion surface from the others. It selects the
 * workspace and makes sure its panel can be seen; the workspace itself starts
 * the session when it is shown, and nothing here starts an export.
 */
export function useOpenConvertWorkspace(): () => void {
  const store = useWorkspaceStore();
  const { showToolPanel } = useShellLayout();
  return useCallback((): void => {
    store.selectWorkflow(WorkflowId.Convert);
    showToolPanel();
  }, [showToolPanel, store]);
}

/**
 * Enter a workspace from the navigation. Both switchers call this and nothing
 * else, so they cannot drift into different behaviour.
 *
 * A WORKSPACE THAT DOES NOT EXIST IS NEVER ENTERED, whichever control asked:
 * the store is not touched, so Hollow cannot become the current workspace by a
 * click, a keypress or an assistive technology's activation.
 */
export function useEnterWorkspace(): (workflow: WorkflowId) => void {
  const store = useWorkspaceStore();
  const openConvert = useOpenConvertWorkspace();
  return useCallback(
    (workflow: WorkflowId): void => {
      const descriptor = WORKFLOWS.find((candidate) => candidate.id === workflow);
      if (descriptor === undefined || !isWorkspaceAvailable(descriptor)) return;
      if (workflow === WorkflowId.Convert) openConvert();
      else store.selectWorkflow(workflow);
    },
    [openConvert, store],
  );
}
