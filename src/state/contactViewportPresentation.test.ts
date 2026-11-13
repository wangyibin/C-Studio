import { describe, expect, it, vi } from "vitest";
import { createContactViewportPresentation } from "./contactViewportPresentation";

const initial = { xStart: 100, xEnd: 400, yStart: 200, yEnd: 400 };
const moved = { xStart: 200, xEnd: 500, yStart: 250, yEnd: 450 };

describe("contact viewport presentation", () => {
  it("replays the latest displayed camera when the Overview mounts after a pan", () => {
    const presentation = createContactViewportPresentation();
    presentation.publish(initial);
    presentation.publish(moved);
    const listener = vi.fn();
    presentation.subscribe(listener);

    expect(listener.mock.calls).toEqual([[moved]]);
    expect(presentation.getViewport()).toEqual(moved);
  });

  it("does not repeat the same camera when React and the pan RAF both publish it", () => {
    const presentation = createContactViewportPresentation();
    const listener = vi.fn();
    presentation.subscribe(listener);
    listener.mockClear();
    presentation.publish(initial);
    presentation.publish({ ...initial });
    presentation.publish(moved);
    presentation.publish({ ...moved });

    expect(listener.mock.calls).toEqual([[initial], [moved]]);
  });

  it("restores cancellation, forgets an unmounted heatmap and releases old listeners", () => {
    const presentation = createContactViewportPresentation();
    const detached = vi.fn();
    const unsubscribe = presentation.subscribe(detached);
    presentation.publish(initial);
    unsubscribe();
    detached.mockClear();
    const current = vi.fn();
    presentation.subscribe(current);
    presentation.publish(moved);
    presentation.publish(initial);
    presentation.publish(null);

    expect(detached).not.toHaveBeenCalled();
    expect(current.mock.calls).toEqual([[initial], [moved], [initial], [null]]);
    expect(presentation.getViewport()).toBeNull();
    const remounted = vi.fn();
    presentation.subscribe(remounted);
    expect(remounted.mock.calls).toEqual([[null]]);
  });
});
