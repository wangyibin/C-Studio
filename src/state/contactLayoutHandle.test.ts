import { describe, expect, it, vi } from "vitest";
import type { ContactMapLayoutBlock } from "./importers";
import {
  contactLayoutIdentity,
  contactLayoutRegistrationBlocks,
  ContactLayoutHandleRegistry,
  isUnknownContactLayoutHandleError,
} from "./contactLayoutHandle";

function layout(
  sourceId: string,
  overrides: Partial<ContactMapLayoutBlock> = {},
): ContactMapLayoutBlock[] {
  return [{
    id: `block-${sourceId}`,
    objectId: "Chr01",
    displayName: `Display ${sourceId}`,
    sourceId,
    sourceStart: 0,
    sourceEnd: 100,
    visualStart: 0,
    visualEnd: 100,
    orientation: "+",
    ...overrides,
  }];
}

describe("contact layout registration identity", () => {
  it("serializes only the six backend projection fields", () => {
    expect(contactLayoutRegistrationBlocks(layout("A"))).toEqual([{
      id: "block-A",
      sourceId: "A",
      sourceStart: 0,
      sourceEnd: 100,
      visualStart: 0,
      orientation: "+",
    }]);
  });

  it("ignores UI-only labels but changes when the backend projection changes", () => {
    const first = layout("A");
    const renamed = layout("A", { objectId: "Renamed", displayName: "Renamed A" });
    const reversed = layout("A", { orientation: "-" });

    expect(contactLayoutIdentity(renamed)).toBe(contactLayoutIdentity(first));
    expect(contactLayoutIdentity(reversed)).not.toBe(contactLayoutIdentity(first));
  });
});

describe("ContactLayoutHandleRegistry", () => {
  it("deduplicates concurrent registrations for equivalent layouts", async () => {
    let resolveRegistration: ((handle: string) => void) | undefined;
    const register = vi.fn(() => new Promise<string>((resolve) => {
      resolveRegistration = resolve;
    }));
    const registry = new ContactLayoutHandleRegistry();

    const first = registry.prepare(layout("A"), register);
    const second = registry.prepare(layout("A"), register);
    await Promise.resolve();
    expect(register).toHaveBeenCalledTimes(1);

    resolveRegistration?.("layout-a");
    await expect(Promise.all([first, second])).resolves.toEqual(["layout-a", "layout-a"]);
  });

  it("bounds settled handles with least-recently-used eviction", async () => {
    const register = vi.fn(async (blocks: ContactMapLayoutBlock[]) => (
      `handle-${blocks[0]?.sourceId}-${register.mock.calls.length}`
    ));
    const registry = new ContactLayoutHandleRegistry(2);
    const a = layout("A");
    const b = layout("B");
    const c = layout("C");

    await registry.prepare(a, register);
    await registry.prepare(b, register);
    await registry.prepare(a, register);
    await registry.prepare(c, register);
    await registry.prepare(b, register);

    expect(register).toHaveBeenCalledTimes(4);
  });

  it("removes a failed registration so a later call can recover", async () => {
    const register = vi.fn()
      .mockRejectedValueOnce(new Error("Tauri reload in progress"))
      .mockResolvedValueOnce("layout-a");
    const registry = new ContactLayoutHandleRegistry();

    await expect(registry.prepare(layout("A"), register)).rejects.toThrow(
      "Tauri reload in progress",
    );
    await expect(registry.prepare(layout("A"), register)).resolves.toBe("layout-a");
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("invalidates an unknown handle, re-registers, and retries only once", async () => {
    const register = vi.fn()
      .mockResolvedValueOnce("layout-old")
      .mockResolvedValueOnce("layout-new");
    const operation = vi.fn(async (handle: string) => {
      if (handle === "layout-old") {
        throw new Error("unknown contact map layout handle: layout-old");
      }
      return `tiles-from-${handle}`;
    });
    const registry = new ContactLayoutHandleRegistry();

    await expect(registry.run(layout("A"), register, operation)).resolves.toBe(
      "tiles-from-layout-new",
    );
    expect(register).toHaveBeenCalledTimes(2);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("shares one recovery registration across concurrent unknown-handle failures", async () => {
    const register = vi.fn()
      .mockResolvedValueOnce("layout-old")
      .mockResolvedValueOnce("layout-new");
    const registry = new ContactLayoutHandleRegistry();
    const blocks = layout("A");
    await registry.prepare(blocks, register);
    const operation = vi.fn(async (handle: string) => {
      if (handle === "layout-old") {
        throw "unknown contact map layout handle: layout-old";
      }
      return handle;
    });

    await expect(Promise.all([
      registry.run(blocks, register, operation),
      registry.run(blocks, register, operation),
    ])).resolves.toEqual(["layout-new", "layout-new"]);
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("does not re-register for cancellation or ordinary backend failures", async () => {
    const register = vi.fn().mockResolvedValue("layout-a");
    const registry = new ContactLayoutHandleRegistry();

    await expect(registry.run(
      layout("A"),
      register,
      async () => {
        throw new Error("contact tile request cancelled");
      },
    )).rejects.toThrow("contact tile request cancelled");
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("recognizes only the stable unknown-handle prefix", () => {
    expect(isUnknownContactLayoutHandleError(
      "unknown contact map layout handle: layout-0000000000000042",
    )).toBe(true);
    expect(isUnknownContactLayoutHandleError(
      new Error("unknown contact map layout handle: layout-old"),
    )).toBe(true);
    expect(isUnknownContactLayoutHandleError("contact tile request cancelled")).toBe(false);
  });
});
