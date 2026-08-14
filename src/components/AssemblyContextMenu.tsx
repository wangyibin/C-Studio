import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";

import {
  assemblyCopyIntervalGroups,
  assemblyCopyInstanceId,
  assemblyContigDisplayName,
  assemblyRenameTarget,
  assemblyRenameValidationError,
  hasDeletableGap,
  hasDissolvableAssemblyBlock,
  hasRemovableChromosomeBoundary,
  selectedBlockIds,
} from "../state/assemblyEditing";
import type { ContactMapLayoutBlock } from "../state/importers";
import { keyboardShortcutLabels } from "../state/keyboardShortcutLabels";
import type { UiAction, UiState } from "../state/uiState";

export interface AssemblyContextMenuPosition {
  x: number;
  y: number;
}

interface ContextMenuSize {
  width: number;
  height: number;
}

const contextMenuGap = 8;
const contextMenuViewportMargin = 8;

export interface AssemblyDeleteCopyStatus {
  totalCopies: number;
  selectedCopies: number;
  remainingCopies: number;
}

export function assemblyDeleteCopyStatus(
  blocks: ContactMapLayoutBlock[],
  selectedIds: ReadonlySet<string>,
  contig: ContactMapLayoutBlock,
): AssemblyDeleteCopyStatus {
  const totalCopies = assemblyCopyIntervalGroups(blocks, contig)
    .filter((group) => group.coversInterval).length;
  const remainingCopies = assemblyCopyIntervalGroups(
    blocks.filter((block) => !selectedIds.has(block.id)),
    contig,
  ).filter((group) => group.coversInterval).length;
  return {
    totalCopies,
    selectedCopies: totalCopies - remainingCopies,
    remainingCopies,
  };
}

function sourceIntervalKey(contig: ContactMapLayoutBlock) {
  return JSON.stringify([contig.sourceId, contig.sourceStart, contig.sourceEnd]);
}

function formatDeleteCopyStatus(
  status: AssemblyDeleteCopyStatus,
  remainingSplitCopies: number,
) {
  if (status.totalCopies === 1) {
    return "Only copy — none remain";
  }
  if (status.remainingCopies === 0) {
    return `All ${status.totalCopies} copies removed — none remain`;
  }
  const splitSuffix = remainingSplitCopies > 0
    ? ` · ${remainingSplitCopies === 1
      ? "remaining copy is split"
      : `${remainingSplitCopies} remaining copies are split`}`
    : "";
  return `${status.selectedCopies} of ${status.totalCopies} copies removed — ${status.remainingCopies} ${
    status.remainingCopies === 1 ? "copy remains" : "copies remain"
  }${splitSuffix}`;
}

export function fitContextMenuToViewport(
  anchor: AssemblyContextMenuPosition,
  menu: ContextMenuSize,
  viewport: ContextMenuSize,
): AssemblyContextMenuPosition {
  const maxX = Math.max(contextMenuViewportMargin, viewport.width - menu.width - contextMenuViewportMargin);
  const maxY = Math.max(contextMenuViewportMargin, viewport.height - menu.height - contextMenuViewportMargin);
  const preferredX = anchor.x + contextMenuGap;
  const preferredY = anchor.y + contextMenuGap;
  const flippedX = anchor.x - menu.width - contextMenuGap;
  const flippedY = anchor.y - menu.height - contextMenuGap;

  return {
    x: clamp(
      preferredX + menu.width <= viewport.width - contextMenuViewportMargin
        ? preferredX
        : flippedX,
      contextMenuViewportMargin,
      maxX,
    ),
    y: clamp(
      preferredY + menu.height <= viewport.height - contextMenuViewportMargin
        ? preferredY
        : flippedY,
      contextMenuViewportMargin,
      maxY,
    ),
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

interface AssemblyContextMenuProps {
  position: AssemblyContextMenuPosition;
  uiState: UiState;
  onUiAction: (action: UiAction) => void;
  onClose: () => void;
  initialMode?: "default" | "rename" | "delete";
  onDeleteConfirmationChange?: (open: boolean) => void;
  fixed?: boolean;
}

export function AssemblyContextMenu({
  position,
  uiState,
  onUiAction,
  onClose,
  initialMode = "default",
  onDeleteConfirmationChange,
  fixed = false,
}: AssemblyContextMenuProps) {
  const shortcuts = keyboardShortcutLabels();
  const menuRef = useRef<HTMLDivElement>(null);
  const renameTarget = assemblyRenameTarget(
    uiState.assembly.blocks,
    uiState.assembly.selection,
  );
  const [renderPosition, setRenderPosition] = useState(position);
  const [renaming, setRenaming] = useState(initialMode === "rename" && Boolean(renameTarget));
  const [renameValue, setRenameValue] = useState(
    initialMode === "rename" ? renameTarget?.currentName ?? "" : "",
  );
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(initialMode === "delete");
  const hasSelection = uiState.assembly.selection !== null;
  const deletableContigIds = uiState.assembly.selection?.kind === "contigs"
    ? new Set(selectedBlockIds(uiState.assembly.blocks, uiState.assembly.selection))
    : new Set<string>();
  const deletableContigs = uiState.assembly.blocks.filter((block) => (
    deletableContigIds.has(block.id)
  ));
  const canDeleteContigs = deletableContigs.length > 0;
  const remainingBlocks = uiState.assembly.blocks.filter((block) => (
    !deletableContigIds.has(block.id)
  ));
  const deletionDetailsByContigId = new Map(deletableContigs.map((contig) => {
    const copyGroups = assemblyCopyIntervalGroups(uiState.assembly.blocks, contig);
    const currentCopyId = assemblyCopyInstanceId(contig);
    const remainingSplitCopies = assemblyCopyIntervalGroups(remainingBlocks, contig)
      .filter((group) => group.coversInterval && group.isSplit).length;
    return [contig.id, {
      copyStatus: assemblyDeleteCopyStatus(uiState.assembly.blocks, deletableContigIds, contig),
      currentCopy: copyGroups.find((group) => group.id === currentCopyId),
      remainingSplitCopies,
    }] as const;
  }));
  const eliminatedSourceIntervals = new Set(
    deletableContigs
      .filter((contig) => (
        deletionDetailsByContigId.get(contig.id)?.copyStatus.remainingCopies === 0
      ))
      .map(sourceIntervalKey),
  ).size;
  const canDeleteGap = hasDeletableGap(
    uiState.assembly.blocks,
    uiState.assembly.selection,
  );
  const canDissolveBlock = hasDissolvableAssemblyBlock(
    uiState.assembly.blocks,
    uiState.assembly.selection,
  );
  const canRemoveChromosomeBoundary = hasRemovableChromosomeBoundary(
    uiState.assembly.blocks,
    uiState.assembly.selection,
  );
  const run = (action: UiAction) => {
    onUiAction(action);
    onClose();
  };
  const beginRename = () => {
    if (!renameTarget) {
      return;
    }
    setRenameValue(renameTarget.currentName);
    setRenameError(null);
    setRenaming(true);
  };
  const submitRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const error = assemblyRenameValidationError(
      uiState.assembly.blocks,
      uiState.assembly.selection,
      renameValue,
    );
    if (error) {
      setRenameError(error);
      return;
    }
    if (renameValue.trim() === renameTarget?.currentName) {
      onClose();
      return;
    }
    run({ type: "renameAssemblySelection", name: renameValue.trim() });
  };

  useEffect(() => {
    onDeleteConfirmationChange?.(confirmingDelete);
    return () => onDeleteConfirmationChange?.(false);
  }, [confirmingDelete, onDeleteConfirmationChange]);

  useLayoutEffect(() => {
    if (!fixed) {
      setRenderPosition(position);
      return;
    }

    const updatePosition = () => {
      const bounds = menuRef.current?.getBoundingClientRect();
      if (!bounds) {
        return;
      }
      setRenderPosition(fitContextMenuToViewport(
        position,
        { width: bounds.width, height: bounds.height },
        { width: window.innerWidth, height: window.innerHeight },
      ));
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updatePosition);
    if (menuRef.current) {
      resizeObserver?.observe(menuRef.current);
    }
    return () => {
      window.removeEventListener("resize", updatePosition);
      resizeObserver?.disconnect();
    };
  }, [fixed, position, renameError, renaming]);

  return (
    <div
      ref={menuRef}
      className={`context-menu${fixed ? " fixed-context-menu" : ""}`}
      style={{ left: renderPosition.x, top: renderPosition.y }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        disabled={!hasSelection}
        aria-keyshortcuts="Escape"
        onClick={() => run({ type: "clearAssemblySelection" })}
      >
        <span>Deselect</span>
        <kbd>Esc</kbd>
      </button>
      {renaming && renameTarget ? (
        <form className="context-menu-rename" onSubmit={submitRename}>
          <label htmlFor="assembly-rename-input">
            Rename {renameTarget.kind}
          </label>
          <input
            id="assembly-rename-input"
            aria-label={`New ${renameTarget.kind} name`}
            autoFocus
            value={renameValue}
            onChange={(event) => {
              setRenameValue(event.target.value);
              setRenameError(null);
            }}
          />
          {renameError ? <small role="alert">{renameError}</small> : null}
          <div className="context-menu-rename-actions">
            <button type="submit">Save</button>
            <button
              type="button"
              onClick={() => {
                setRenaming(false);
                setRenameError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          disabled={!renameTarget}
          aria-keyshortcuts="Control+E Meta+E"
          onClick={beginRename}
        >
          <span>Rename…</span>
          <kbd>{shortcuts.rename}</kbd>
        </button>
      )}
      <button
        type="button"
        disabled={!hasSelection}
        aria-keyshortcuts="Control+Shift+R Meta+Shift+R"
        onClick={() => run({ type: "reverseAssemblySelection" })}
      >
        <span>Reverse / rotate selection</span>
        <kbd>{shortcuts.reverse}</kbd>
      </button>
      <button
        type="button"
        disabled={!hasSelection}
        aria-keyshortcuts="Control+D Meta+D"
        onClick={() => run({ type: "copyAssemblySelection" })}
      >
        <span>Copy</span>
        <kbd>{shortcuts.copy}</kbd>
      </button>
      <button
        type="button"
        disabled={!hasSelection}
        aria-keyshortcuts="Control+Shift+D Meta+Shift+D"
        onClick={() => run({ type: "moveAssemblySelectionToDebris" })}
      >
        <span>Move to debris</span>
        <kbd>{shortcuts.moveToDebris}</kbd>
      </button>
      <button
        type="button"
        className="context-menu-danger"
        disabled={!canDeleteContigs}
        aria-keyshortcuts="Shift+Delete Shift+Backspace"
        onClick={() => setConfirmingDelete(true)}
      >
        <span>Delete contig…</span>
        <kbd>{shortcuts.deleteContig}</kbd>
      </button>
      <button
        type="button"
        disabled={!canDissolveBlock}
        title={canDissolveBlock
          ? "Split the selected composite block into singleton contigs"
          : "Select a composite block first"}
        onClick={() => run({ type: "dissolveAssemblyBlockSelection" })}
      >
        Dissolve block
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
        disabled={!canRemoveChromosomeBoundary}
        onClick={() => run({ type: "removeAssemblyChromosomeBoundaries" })}
      >
        Remove chr boundaries
      </button>
      <button
        type="button"
        disabled={!canDeleteGap}
        aria-keyshortcuts="Control+J Meta+J"
        onClick={() => run({ type: "deleteAssemblyGaps" })}
      >
        <span>Delete gap / join blocks</span>
        <kbd>{shortcuts.deleteGap}</kbd>
      </button>
      <button
        type="button"
        disabled={uiState.operationHistory.length === 0}
        aria-keyshortcuts="Control+Z Meta+Z Control+U Meta+U"
        onClick={() => run({ type: "undo" })}
      >
        <span>Undo</span>
        <kbd>{shortcuts.undo}</kbd>
      </button>
      <button
        type="button"
        disabled={uiState.redoStack.length === 0}
        aria-keyshortcuts="Meta+Shift+Z Control+Y Control+R Meta+R"
        onClick={() => run({ type: "redo" })}
      >
        <span>Redo</span>
        <kbd>{shortcuts.redo}</kbd>
      </button>
      {confirmingDelete ? (
        <div
          className="assembly-delete-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setConfirmingDelete(false);
            }
          }}
        >
          <section
            className="assembly-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="assembly-delete-title"
            aria-describedby="assembly-delete-description"
          >
            <h2 id="assembly-delete-title">
              Delete {deletableContigs.length === 1 ? "contig" : `${deletableContigs.length} contigs`}?
            </h2>
            <p id="assembly-delete-description">
              This removes the selection from the assembly. It will not be kept in debris.
              You can recover it with Undo during this session.
            </p>
            <p className={eliminatedSourceIntervals > 0
              ? "assembly-delete-copy-summary copy-loss"
              : "assembly-delete-copy-summary copy-retained"}
            >
              {eliminatedSourceIntervals > 0
                ? `${eliminatedSourceIntervals} selected source ${
                  eliminatedSourceIntervals === 1 ? "interval has" : "intervals have"
                } no copies left after deletion.`
                : "Other copies will remain for every selected contig."}
            </p>
            <ul>
              {deletableContigs.slice(0, 8).map((contig) => {
                const details = deletionDetailsByContigId.get(contig.id);
                return (
                  <li key={contig.id}>
                    <div className="assembly-delete-contig-line">
                      <span>{assemblyContigDisplayName(contig)}</span>
                      <small>{contig.objectId}</small>
                    </div>
                    <em className={details?.currentCopy?.isSplit ? "copy-split" : "copy-unsplit"}>
                      {details?.currentCopy?.isSplit
                        ? `Split copy · ${details.currentCopy.blocks.length} segments`
                        : "Unsplit copy"}
                    </em>
                    {details ? (
                      <strong className={details.copyStatus.remainingCopies === 0
                        ? "copy-loss"
                        : "copy-retained"}
                      >
                        {formatDeleteCopyStatus(
                          details.copyStatus,
                          details.remainingSplitCopies,
                        )}
                      </strong>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {deletableContigs.length > 8 ? (
              <p className="assembly-delete-more">
                +{deletableContigs.length - 8} more contigs
              </p>
            ) : null}
            <div className="assembly-delete-actions">
              <button
                type="button"
                autoFocus
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger-confirm"
                onClick={() => run({ type: "deleteAssemblySelection" })}
              >
                Delete {deletableContigs.length === 1 ? "contig" : `${deletableContigs.length} contigs`}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
