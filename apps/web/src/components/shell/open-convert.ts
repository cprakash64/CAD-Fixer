import { useCallback } from 'react';
import { useWorkspaceStore } from '../../state/store-context';
import { WorkflowId } from '../../state/workflows';
import { useShellLayout } from './shell-layout';

/**
 * "Export" everywhere in the product means: go to the Convert workspace.
 *
 * ONE ROUTE FOR EVERY ENTRY POINT — the top bar's Export, the inspector's
 * Export / Convert, the workspace tabs and the dropdown — so none of them can
 * open a different conversion surface from the others. It selects the
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
