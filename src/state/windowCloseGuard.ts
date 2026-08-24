export const unsavedCloseButtons = {
  yes: "Save",
  no: "Discard Changes",
  cancel: "Cancel",
} as const;

export type UnsavedCloseDecision = "save" | "discard" | "cancel";
export type WindowCloseRequestAction = "destroy" | "prompt" | "wait";

export function unsavedCloseDecision(result: string): UnsavedCloseDecision {
  if (result === unsavedCloseButtons.yes) {
    return "save";
  }
  if (result === unsavedCloseButtons.no) {
    return "discard";
  }
  return "cancel";
}

export function shouldPromptForUnsavedClose({
  dirty,
  allowClose,
}: {
  dirty: boolean;
  allowClose: boolean;
}) {
  return dirty && !allowClose;
}

/** Resolve a native close request before any asynchronous dialog work begins. */
export function windowCloseRequestAction({
  dirty,
  allowClose,
  promptOpen,
}: {
  dirty: boolean;
  allowClose: boolean;
  promptOpen: boolean;
}): WindowCloseRequestAction {
  if (allowClose || !dirty) {
    return "destroy";
  }
  return promptOpen ? "wait" : "prompt";
}

export async function shouldContinueClosing(
  decision: UnsavedCloseDecision,
  save: () => Promise<boolean>,
) {
  if (decision === "cancel") {
    return false;
  }
  if (decision === "discard") {
    return true;
  }
  return save();
}
