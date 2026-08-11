export interface ContactTileLruLimits {
  maxScopes: number;
  maxTiles: number;
  maxCells: number;
}

/**
 * Three scopes retain the active resolution and its two nearest idle-prefetch
 * candidates. The tile and cell budgets preserve the frontend limits that
 * predate the scope-aware LRU.
 */
export const defaultContactTileLruLimits: Readonly<ContactTileLruLimits> = Object.freeze({
  maxScopes: 3,
  maxTiles: 96,
  maxCells: 750_000,
});

export interface ContactTileLruScope {
  /** Opaque render/data scope. Do not derive this by parsing a tile cache key. */
  id: string;
  resolution: number;
}

export interface ContactTileLruEntry<T> {
  /** Existing contact tile cache key, treated as an opaque identity. */
  key: string;
  value: T;
  cellCount: number;
}

export interface ContactTileLruProtection {
  /** Soft protection: these entries are evicted only after unprotected entries. */
  keys?: ReadonlySet<string>;
  /** Soft protection: these scopes are evicted only after unprotected scopes. */
  scopes?: ReadonlySet<string>;
}

export interface ContactTileLruMergeOptions extends ContactTileLruProtection {
  /**
   * Background inserts remain least-recently-used and are not auto-protected,
   * so idle prefetch cannot displace the foreground layer under pressure.
   */
  recency?: "foreground" | "background";
}

export type ContactTileLruEvictionReason = "scope-limit" | "tile-limit" | "cell-limit";

export interface ContactTileLruEviction {
  key: string;
  scope: string;
  resolution: number;
  cellCount: number;
  reason: ContactTileLruEvictionReason;
}

export interface ContactTileLruScopeStats {
  id: string;
  resolution: number;
  tileCount: number;
  cellCount: number;
}

export interface ContactTileLruStats {
  tileCount: number;
  cellCount: number;
  /** Least-recently-used scope first. */
  scopes: readonly ContactTileLruScopeStats[];
}

export interface ContactTileLruMutation {
  evicted: readonly ContactTileLruEviction[];
  stats: ContactTileLruStats;
}

/**
 * Overlay correctness-critical visible entries onto a strict reusable-cache
 * snapshot without mutating either input.
 */
export function contactTileRenderCache<T>(
  reusableCache: ReadonlyMap<string, T>,
  visibleAssembly: ReadonlyMap<string, T>,
): Map<string, T> {
  const renderCache = new Map(reusableCache);
  for (const [key, value] of visibleAssembly) {
    renderCache.set(key, value);
  }
  return renderCache;
}

interface StoredContactTile<T> {
  key: string;
  value: T;
  cellCount: number;
  scope: string;
  resolution: number;
}

interface StoredContactTileScope {
  id: string;
  resolution: number;
  /** Least-recently-used tile first. */
  keys: Map<string, true>;
}

/**
 * A scope-aware, in-memory contact tile LRU with strict tile and cell budgets.
 *
 * Scope and resolution are explicit metadata because contact tile keys contain
 * paths and projection fingerprints and therefore must not be reverse-parsed.
 * The cache first removes whole least-recently-used scopes, then individual
 * least-recently-used tiles when the global tile or cell budget is exceeded.
 */
export class ContactTileResolutionLru<T> {
  readonly limits: Readonly<ContactTileLruLimits>;

  private readonly records = new Map<string, StoredContactTile<T>>();
  private readonly scopes = new Map<string, StoredContactTileScope>();
  private totalCells = 0;

  constructor(limits: Partial<ContactTileLruLimits> = {}) {
    this.limits = Object.freeze(validateLimits({
      ...defaultContactTileLruLimits,
      ...limits,
    }));
  }

  get size() {
    return this.records.size;
  }

  get cellCount() {
    return this.totalCells;
  }

  get scopeCount() {
    return this.scopes.size;
  }

  /** Returns and promotes one tile within its currently assigned scope. */
  get(key: string): T | undefined {
    const record = this.records.get(key);
    if (!record) {
      return undefined;
    }

    this.promoteRecord(record);
    return record.value;
  }

  /** Returns a tile without changing recency. */
  peek(key: string): T | undefined {
    return this.records.get(key)?.value;
  }

  /** Tests membership without changing recency. */
  has(key: string) {
    return this.records.has(key);
  }

  /** Promotes an existing scope without creating an empty scope. */
  touchScope(scopeId: string) {
    const scope = this.scopes.get(scopeId);
    if (!scope) {
      return false;
    }

    this.promoteScope(scope);
    return true;
  }

  /**
   * Reassigns reusable cached keys to the scope that just consumed them.
   * Missing keys are ignored. This is useful when a layout edit reuses the same
   * tile-local projection key under a new global render scope.
   */
  touch(
    scopeInput: ContactTileLruScope,
    keys: Iterable<string>,
    protection: ContactTileLruProtection = {},
  ): ContactTileLruMutation {
    const scope = validateScope(scopeInput);
    const records = uniqueExistingRecords(keys, this.records);
    if (records.length === 0) {
      return { evicted: [], stats: this.stats() };
    }

    const targetScope = this.ensureScope(scope);
    for (const record of records) {
      this.assignRecordToScope(record, targetScope);
    }

    return this.trim(withProtectedScope(protection, scope.id));
  }

  /** Adds or replaces a batch, then enforces all limits once atomically. */
  merge(
    scopeInput: ContactTileLruScope,
    entries: Iterable<ContactTileLruEntry<T>>,
    options: ContactTileLruMergeOptions = {},
  ): ContactTileLruMutation {
    const scope = validateScope(scopeInput);
    const validatedEntries = validateEntries(entries);
    if (validatedEntries.length === 0) {
      if (options.recency !== "background") {
        this.touchScope(scope.id);
      }
      return { evicted: [], stats: this.stats() };
    }

    const foreground = options.recency !== "background";
    const targetScope = this.ensureScope(scope, foreground);
    for (const entry of validatedEntries) {
      const existing = this.records.get(entry.key);
      if (existing) {
        const movedToAnotherScope = existing.scope !== scope.id;
        this.totalCells -= existing.cellCount;
        if (foreground || movedToAnotherScope) {
          this.removeRecordFromScope(existing);
        }
        existing.value = entry.value;
        existing.cellCount = entry.cellCount;
        existing.scope = scope.id;
        existing.resolution = scope.resolution;
        if (foreground) {
          this.records.delete(entry.key);
          this.records.set(entry.key, existing);
          targetScope.keys.delete(entry.key);
        }
        if (foreground || movedToAnotherScope) {
          targetScope.keys.set(entry.key, true);
        }
      } else {
        const record: StoredContactTile<T> = {
          ...entry,
          scope: scope.id,
          resolution: scope.resolution,
        };
        this.records.set(entry.key, record);
        targetScope.keys.set(entry.key, true);
      }
      this.totalCells += entry.cellCount;
    }

    this.removeEmptyScopes(scope.id);
    return this.trim(foreground ? withProtectedScope(options, scope.id) : options);
  }

  delete(key: string) {
    const record = this.records.get(key);
    if (!record) {
      return false;
    }

    this.deleteRecord(record);
    return true;
  }

  deleteScope(scopeId: string) {
    const scope = this.scopes.get(scopeId);
    if (!scope) {
      return [];
    }

    const deletedKeys = [...scope.keys.keys()];
    for (const key of deletedKeys) {
      const record = this.records.get(key);
      if (record) {
        this.deleteRecord(record);
      }
    }
    return deletedKeys;
  }

  clear() {
    this.records.clear();
    this.scopes.clear();
    this.totalCells = 0;
  }

  /** A detached Map suitable for React state and existing tile-world helpers. */
  toMap(): Map<string, T> {
    return new Map([...this.records].map(([key, record]) => [key, record.value]));
  }

  /** A detached, read-only snapshot suitable for load planning. */
  view(): ReadonlyMap<string, T> {
    return this.toMap();
  }

  stats(): ContactTileLruStats {
    return {
      tileCount: this.records.size,
      cellCount: this.totalCells,
      scopes: [...this.scopes.values()].map((scope) => {
        let cellCount = 0;
        for (const key of scope.keys.keys()) {
          cellCount += this.records.get(key)?.cellCount ?? 0;
        }
        return {
          id: scope.id,
          resolution: scope.resolution,
          tileCount: scope.keys.size,
          cellCount,
        };
      }),
    };
  }

  private trim(protection: ContactTileLruProtection): ContactTileLruMutation {
    const evicted: ContactTileLruEviction[] = [];

    while (this.scopes.size > this.limits.maxScopes) {
      const scope = this.scopeForEviction(protection);
      if (!scope) {
        break;
      }
      for (const key of [...scope.keys.keys()]) {
        const record = this.records.get(key);
        if (record) {
          evicted.push(this.evictRecord(record, "scope-limit"));
        }
      }
    }

    while (
      this.records.size > this.limits.maxTiles
      || this.totalCells > this.limits.maxCells
    ) {
      const record = this.recordForEviction(protection);
      if (!record) {
        break;
      }
      const reason = this.records.size > this.limits.maxTiles
        ? "tile-limit"
        : "cell-limit";
      evicted.push(this.evictRecord(record, reason));
    }

    return { evicted, stats: this.stats() };
  }

  private ensureScope(scopeInput: ContactTileLruScope, promote = true) {
    const existing = this.scopes.get(scopeInput.id);
    if (existing) {
      if (existing.resolution !== scopeInput.resolution) {
        throw new Error(
          `contact tile scope ${scopeInput.id} changed resolution from ${existing.resolution} to ${scopeInput.resolution}`,
        );
      }
      if (promote) {
        this.promoteScope(existing);
      }
      return existing;
    }

    const scope: StoredContactTileScope = {
      ...scopeInput,
      keys: new Map(),
    };
    if (promote) {
      this.scopes.set(scope.id, scope);
    } else {
      const existingScopes = [...this.scopes];
      this.scopes.clear();
      this.scopes.set(scope.id, scope);
      for (const [scopeId, existingScope] of existingScopes) {
        this.scopes.set(scopeId, existingScope);
      }
    }
    return scope;
  }

  private assignRecordToScope(
    record: StoredContactTile<T>,
    scope: StoredContactTileScope,
  ) {
    this.removeRecordFromScope(record);
    record.scope = scope.id;
    record.resolution = scope.resolution;
    scope.keys.delete(record.key);
    scope.keys.set(record.key, true);
    this.records.delete(record.key);
    this.records.set(record.key, record);
    this.promoteScope(scope);
    this.removeEmptyScopes(scope.id);
  }

  private promoteRecord(record: StoredContactTile<T>) {
    const scope = this.scopes.get(record.scope);
    if (scope) {
      scope.keys.delete(record.key);
      scope.keys.set(record.key, true);
      this.promoteScope(scope);
    }
    this.records.delete(record.key);
    this.records.set(record.key, record);
  }

  private promoteScope(scope: StoredContactTileScope) {
    this.scopes.delete(scope.id);
    this.scopes.set(scope.id, scope);
  }

  private removeRecordFromScope(record: StoredContactTile<T>) {
    this.scopes.get(record.scope)?.keys.delete(record.key);
  }

  private removeEmptyScopes(exceptScopeId?: string) {
    for (const [scopeId, scope] of this.scopes) {
      if (scopeId !== exceptScopeId && scope.keys.size === 0) {
        this.scopes.delete(scopeId);
      }
    }
  }

  private scopeForEviction(protection: ContactTileLruProtection) {
    const scopes = [...this.scopes.values()];
    return scopes.find((scope) => (
      !protection.scopes?.has(scope.id)
      && !scopeContainsProtectedKey(scope, protection.keys)
    ))
      ?? scopes.find((scope) => !protection.scopes?.has(scope.id))
      ?? scopes.find((scope) => !scopeContainsProtectedKey(scope, protection.keys))
      ?? scopes[0];
  }

  private recordForEviction(protection: ContactTileLruProtection) {
    const scopes = [...this.scopes.values()];
    return oldestRecord(
      scopes.filter((scope) => !protection.scopes?.has(scope.id)),
      this.records,
      protection.keys,
    )
      ?? oldestRecord(scopes, this.records, protection.keys)
      ?? oldestRecord(
        scopes.filter((scope) => !protection.scopes?.has(scope.id)),
        this.records,
      )
      ?? oldestRecord(scopes, this.records);
  }

  private evictRecord(
    record: StoredContactTile<T>,
    reason: ContactTileLruEvictionReason,
  ): ContactTileLruEviction {
    const eviction = {
      key: record.key,
      scope: record.scope,
      resolution: record.resolution,
      cellCount: record.cellCount,
      reason,
    };
    this.deleteRecord(record);
    return eviction;
  }

  private deleteRecord(record: StoredContactTile<T>) {
    this.records.delete(record.key);
    const scope = this.scopes.get(record.scope);
    scope?.keys.delete(record.key);
    this.totalCells -= record.cellCount;
    if (scope?.keys.size === 0) {
      this.scopes.delete(scope.id);
    }
  }
}

function validateLimits(limits: ContactTileLruLimits): ContactTileLruLimits {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  return limits;
}

function validateScope(scope: ContactTileLruScope): ContactTileLruScope {
  if (scope.id.length === 0) {
    throw new Error("contact tile scope id must not be empty");
  }
  if (!Number.isSafeInteger(scope.resolution) || scope.resolution <= 0) {
    throw new Error("contact tile scope resolution must be a positive safe integer");
  }
  return { ...scope };
}

function validateEntries<T>(entries: Iterable<ContactTileLruEntry<T>>) {
  const byKey = new Map<string, ContactTileLruEntry<T>>();
  for (const entry of entries) {
    if (entry.key.length === 0) {
      throw new Error("contact tile cache key must not be empty");
    }
    if (!Number.isSafeInteger(entry.cellCount) || entry.cellCount < 0) {
      throw new Error("contact tile cell count must be a non-negative safe integer");
    }
    // Last write wins, and its position becomes the newest one in the batch.
    byKey.delete(entry.key);
    byKey.set(entry.key, { ...entry });
  }
  return [...byKey.values()];
}

function uniqueExistingRecords<T>(
  keys: Iterable<string>,
  records: ReadonlyMap<string, StoredContactTile<T>>,
) {
  const uniqueRecords = new Map<string, StoredContactTile<T>>();
  for (const key of keys) {
    const record = records.get(key);
    if (record) {
      uniqueRecords.delete(key);
      uniqueRecords.set(key, record);
    }
  }
  return [...uniqueRecords.values()];
}

function withProtectedScope(
  protection: ContactTileLruProtection,
  activeScopeId: string,
): ContactTileLruProtection {
  return {
    keys: protection.keys,
    scopes: new Set([...(protection.scopes ?? []), activeScopeId]),
  };
}

function scopeContainsProtectedKey(
  scope: StoredContactTileScope,
  protectedKeys: ReadonlySet<string> | undefined,
) {
  if (!protectedKeys || protectedKeys.size === 0) {
    return false;
  }
  for (const key of scope.keys.keys()) {
    if (protectedKeys.has(key)) {
      return true;
    }
  }
  return false;
}

function oldestRecord<T>(
  scopes: readonly StoredContactTileScope[],
  records: ReadonlyMap<string, StoredContactTile<T>>,
  excludedKeys?: ReadonlySet<string>,
) {
  for (const scope of scopes) {
    for (const key of scope.keys.keys()) {
      if (!excludedKeys?.has(key)) {
        const record = records.get(key);
        if (record) {
          return record;
        }
      }
    }
  }
  return undefined;
}
