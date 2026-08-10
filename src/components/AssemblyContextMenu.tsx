import type { UiAction, UiState } from "../state/uiState";

export interface AssemblyContextMenuPosition {
  x: number;
  y: number;
}

interface AssemblyContextMenuProps {
  position: AssemblyContextMenuPosition;
  uiState: UiState;
  onUiAction: (action: UiAction) => void;
  onClose: () => void;
  fixed?: boolean;
}

export function AssemblyContextMenu({
  position,
  uiState,
  onUiAction,
  onClose,
  fixed = false,
}: AssemblyContextMenuProps) {
  const hasSelection = uiState.assembly.selection !== null;
  const run = (action: UiAction) => {
    onUiAction(action);
    onClose();
  };

  return (
    <div
      className={`context-menu${fixed ? " fixed-context-menu" : ""}`}
      style={{ left: position.x, top: position.y }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        disabled={!hasSelection}
        onClick={() => run({ type: "clearAssemblySelection" })}
      >
        Deselect
      </button>
      <button
        type="button"
        disabled={!hasSelection}
        onClick={() => run({ type: "reverseAssemblySelection" })}
      >
        Reverse / rotate selection
      </button>
      <button
        type="button"
        disabled={!hasSelection}
        onClick={() => run({ type: "copyAssemblySelection" })}
      >
        Copy
      </button>
      <button
        type="button"
        disabled={!hasSelection}
        onClick={() => run({ type: "moveAssemblySelectionToDebris" })}
      >
        Move to debris
      </button>
      <button
        type="button"
        disabled={uiState.assembly.selection?.kind !== "contigs"
          || uiState.assembly.selection.ids.length === 0}
        onClick={() => run({ type: "addAssemblyChromosomeBoundaries" })}
      >
        Add chr boundaries
      </button>
      <button
        type="button"
        disabled={uiState.operationHistory.length === 0}
        onClick={() => run({ type: "undo" })}
      >
        Undo
      </button>
      <button
        type="button"
        disabled={uiState.redoStack.length === 0}
        onClick={() => run({ type: "redo" })}
      >
        Redo
      </button>
    </div>
  );
}
