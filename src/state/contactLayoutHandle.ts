import type { ContactMapLayoutBlock } from "./importers";

export const unknownContactLayoutHandlePrefix = "unknown contact map layout handle";

export type RegisterContactLayout = (
  layoutBlocks: ContactMapLayoutBlock[],
) => Promise<string>;

interface ContactLayoutHandleEntry {
  identity: string;
  promise: Promise<string>;
  handle: string | null;
  settled: boolean;
}

interface ContactLayoutHandleLease {
  identity: string;
  entry: ContactLayoutHandleEntry;
  handle: string;
}

const layoutIdentityCache = new WeakMap<ContactMapLayoutBlock[], string>();

export function contactLayoutRegistrationBlocks(layoutBlocks: ContactMapLayoutBlock[]) {
  return layoutBlocks.map((block) => ({
    id: block.id,
    sourceId: block.sourceId,
    sourceStart: block.sourceStart,
    sourceEnd: block.sourceEnd,
    visualStart: block.visualStart,
    orientation: block.orientation,
  }));
}

/**
 * Exact identity of the layout payload understood by the contact-tile backend.
 * UI-only labels and AGP metadata deliberately do not cause another registration.
 */
export function contactLayoutIdentity(layoutBlocks: ContactMapLayoutBlock[]) {
  const cached = layoutIdentityCache.get(layoutBlocks);
  if (cached !== undefined) {
    return cached;
  }
  const identity = JSON.stringify(contactLayoutRegistrationBlocks(layoutBlocks));
  layoutIdentityCache.set(layoutBlocks, identity);
  return identity;
}

export function isUnknownContactLayoutHandleError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().startsWith(unknownContactLayoutHandlePrefix);
}

/**
 * Bounded semantic-layout LRU. Pending registrations are never evicted, so
 * concurrent tile purposes share exactly one registration promise.
 */
export class ContactLayoutHandleRegistry {
  private readonly entries = new Map<string, ContactLayoutHandleEntry>();

  constructor(private readonly capacity = 8) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("contact layout handle capacity must be a positive integer");
    }
  }

  prepare(
    layoutBlocks: ContactMapLayoutBlock[],
    register: RegisterContactLayout,
  ): Promise<string> {
    return this.acquire(layoutBlocks, register).then((lease) => lease.handle);
  }

  async run<T>(
    layoutBlocks: ContactMapLayoutBlock[],
    register: RegisterContactLayout,
    operation: (layoutHandle: string) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquire(layoutBlocks, register);
    try {
      return await operation(lease.handle);
    } catch (error) {
      if (!isUnknownContactLayoutHandleError(error)) {
        throw error;
      }
      this.invalidate(lease);
    }

    const retryLease = await this.acquire(layoutBlocks, register);
    try {
      return await operation(retryLease.handle);
    } catch (error) {
      if (isUnknownContactLayoutHandleError(error)) {
        this.invalidate(retryLease);
      }
      throw error;
    }
  }

  private acquire(
    layoutBlocks: ContactMapLayoutBlock[],
    register: RegisterContactLayout,
  ): Promise<ContactLayoutHandleLease> {
    const identity = contactLayoutIdentity(layoutBlocks);
    let entry = this.entries.get(identity);
    if (!entry) {
      entry = this.createEntry(identity, layoutBlocks, register);
      this.entries.set(identity, entry);
      this.trimSettledEntries();
    } else {
      this.touch(identity, entry);
    }

    return entry.promise.then((handle) => {
      if (this.entries.get(identity) === entry) {
        this.touch(identity, entry);
        this.trimSettledEntries();
      }
      return { identity, entry, handle };
    });
  }

  private createEntry(
    identity: string,
    layoutBlocks: ContactMapLayoutBlock[],
    register: RegisterContactLayout,
  ): ContactLayoutHandleEntry {
    const entry: ContactLayoutHandleEntry = {
      identity,
      promise: Promise.resolve(""),
      handle: null,
      settled: false,
    };
    entry.promise = Promise.resolve()
      .then(() => register(layoutBlocks))
      .then((handle) => {
        if (!handle) {
          throw new Error("contact layout registration returned an empty handle");
        }
        entry.handle = handle;
        entry.settled = true;
        return handle;
      })
      .catch((error) => {
        entry.settled = true;
        if (this.entries.get(identity) === entry) {
          this.entries.delete(identity);
        }
        throw error;
      });
    return entry;
  }

  private invalidate(lease: ContactLayoutHandleLease) {
    if (this.entries.get(lease.identity) === lease.entry) {
      this.entries.delete(lease.identity);
    }
  }

  private touch(identity: string, entry: ContactLayoutHandleEntry) {
    this.entries.delete(identity);
    this.entries.set(identity, entry);
  }

  private trimSettledEntries() {
    while (this.entries.size > this.capacity) {
      const oldestSettled = [...this.entries].find(([, entry]) => entry.settled);
      if (!oldestSettled) {
        return;
      }
      this.entries.delete(oldestSettled[0]);
    }
  }
}
