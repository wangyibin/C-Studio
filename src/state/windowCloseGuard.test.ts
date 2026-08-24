import { describe, expect, it } from "vitest";
import {
  shouldContinueClosing,
  shouldPromptForUnsavedClose,
  unsavedCloseButtons,
  unsavedCloseDecision,
  windowCloseRequestAction,
} from "./windowCloseGuard";

describe("window close guard", () => {
  it("only prompts while the assembly has unsaved changes", () => {
    expect(shouldPromptForUnsavedClose({ dirty: true, allowClose: false })).toBe(true);
    expect(shouldPromptForUnsavedClose({ dirty: false, allowClose: false })).toBe(false);
    expect(shouldPromptForUnsavedClose({ dirty: true, allowClose: true })).toBe(false);
  });

  it("destroys a clean native window instead of leaving the request implicit", () => {
    expect(windowCloseRequestAction({
      dirty: false,
      allowClose: false,
      promptOpen: false,
    })).toBe("destroy");
    expect(windowCloseRequestAction({
      dirty: true,
      allowClose: true,
      promptOpen: false,
    })).toBe("destroy");
  });

  it("opens at most one prompt for a dirty native window", () => {
    expect(windowCloseRequestAction({
      dirty: true,
      allowClose: false,
      promptOpen: false,
    })).toBe("prompt");
    expect(windowCloseRequestAction({
      dirty: true,
      allowClose: false,
      promptOpen: true,
    })).toBe("wait");
  });

  it("maps the native dialog buttons to close decisions", () => {
    expect(unsavedCloseDecision(unsavedCloseButtons.yes)).toBe("save");
    expect(unsavedCloseDecision(unsavedCloseButtons.no)).toBe("discard");
    expect(unsavedCloseDecision(unsavedCloseButtons.cancel)).toBe("cancel");
  });

  it("treats an unexpected dialog result as cancel", () => {
    expect(unsavedCloseDecision("unexpected")).toBe("cancel");
  });

  it("only continues after discarding changes or completing a save", async () => {
    let saveAttempts = 0;
    const successfulSave = async () => {
      saveAttempts += 1;
      return true;
    };
    const canceledSave = async () => {
      saveAttempts += 1;
      return false;
    };

    expect(await shouldContinueClosing("cancel", successfulSave)).toBe(false);
    expect(await shouldContinueClosing("discard", successfulSave)).toBe(true);
    expect(saveAttempts).toBe(0);
    expect(await shouldContinueClosing("save", canceledSave)).toBe(false);
    expect(await shouldContinueClosing("save", successfulSave)).toBe(true);
    expect(saveAttempts).toBe(2);
  });
});
