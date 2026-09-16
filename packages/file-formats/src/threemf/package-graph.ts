import type { InflationBudget, ZipEntry } from './zip';
import type { ModelPartKey } from './package-path';

/**
 * THE PACKAGE GRAPH — Stage 6D-A1 foundation.
 *
 * A 3MF package may hold its objects in several `.model` parts. The reader
 * today opens exactly one, and every identity it uses is scoped to that one
 * without saying so. This module introduces the container that owns the others,
 * and — more importantly — the three ownership rules A2 must not be able to
 * break by accident.
 *
 * NOTHING IN PRODUCTION CONSTRUCTS ONE YET. `read3mf` still opens the root part
 * and still refuses every production-extension package. This is types,
 * contracts and their tests; the compatibility boundary moves in A2.
 *
 * THE THREE RULES THIS EXISTS TO ENFORCE:
 *
 *   1. ONE PARSE PER CANONICAL PART. A package may place the same referenced
 *      object fifty times; the part behind it is parsed once and its result
 *      shared. `ensurePart` is the only way in, and it is a get-or-parse.
 *   2. REACHABILITY DECIDES WHAT IS READ. A `.model` entry nothing references
 *      is never opened, never inflated and never charged. The graph is
 *      populated by demand, never by enumerating the directory — which is why
 *      there is no `loadAll` and why `entries` is only ever a lookup table.
 *   3. ONE BUDGET FOR THE PACKAGE. The graph HOLDS the archive's single
 *      `InflationBudget` so that a part cannot be given a fresh allowance. A
 *      per-part budget is a per-part FULL allowance, which is how a package
 *      with twenty parts extracts twenty times the ceiling.
 *
 * WHAT THIS DOES NOT SETTLE. Stage 6D-B3 measured the existing import-memory
 * model against real Chromium and found it under-predicts by roughly an order
 * of magnitude for 3MF. `maxImportPeakBytes` therefore must NOT be treated as
 * the safety gate for loading additional parts. That reconciliation is Stage
 * 6D-R1 and is owed before A2 reads a second part.
 */

/**
 * Which model part this is, in the package's terms.
 *
 * THE DISTINCTION IS NORMATIVE, not bookkeeping. The specification gives the
 * root part the package's only valid build section, permits a `path` on a
 * component only in the root part, and requires consumers to IGNORE the build
 * entries of referenced parts. A parser that cannot be told which role it is
 * reading cannot honour any of that.
 */
export const ModelPartRole = {
  /** The part the package's build section belongs to. Exactly one per package. */
  Root: 'root',
  /** A part reached from the root by a production-extension reference. */
  Referenced: 'referenced',
} as const;

export type ModelPartRole = (typeof ModelPartRole)[keyof typeof ModelPartRole];

/**
 * One parsed model part.
 *
 * `unit` IS RETAINED AS DECLARED AND PER PART, never reconciled here. The
 * specification says nothing about what a referenced part's differing unit
 * means, and CAD Fixer holds ONE unit authority and never rescales — so A3 has
 * to be able to see each part's own declaration in order to refuse a
 * disagreement rather than silently adopt the root's. Adopting the root's here
 * would destroy the evidence that a disagreement existed.
 */
export interface ModelPart<TParsed> {
  readonly key: ModelPartKey;
  readonly role: ModelPartRole;
  /** Exactly what this part's `<model unit>` said. `undefined` means absent. */
  readonly unit: string | undefined;
  /** The reader's own parse result for this part. */
  readonly parsed: TParsed;
}

/**
 * A reference from one model part to an object in another.
 *
 * CARRIES BOTH ENDS. The source is needed because the specification forbids a
 * `path` on a component outside the root part, and a consumer is required to
 * error on one — a rule that cannot be checked by a structure that has
 * forgotten where the reference came from.
 *
 * The transform is the component's own, unchanged: Float64, 3x4, never baked.
 */
export interface CrossPartObjectReference<TTransform> {
  readonly from: ModelPartKey;
  readonly to: ModelPartKey;
  readonly objectId: string;
  readonly transform: TTransform;
}

/** Parses one model part's bytes. Supplied by the caller; the graph never parses. */
export type ModelPartLoader<TParsed> = (
  entry: ZipEntry,
  key: ModelPartKey,
  role: ModelPartRole,
) => Promise<{ readonly parsed: TParsed; readonly unit: string | undefined }>;

export interface PackageModelGraphOptions<TParsed> {
  readonly rootKey: ModelPartKey;
  /** The archive directory, for lookup ONLY. Never enumerated into the graph. */
  readonly entries: readonly ZipEntry[];
  /** THE archive's budget. One per import, shared by every part. */
  readonly budget: InflationBudget;
  readonly load: ModelPartLoader<TParsed>;
  /**
   * The most model parts one package may have LOADED.
   *
   * DELIBERATELY NOT GIVEN A PRODUCTION DEFAULT IN STAGE 6D-A1. Picking a
   * number here would be inventing a resource policy with no measurement behind
   * it, which is the opposite of what Stage 6D-B3 just established. The
   * plumbing exists so A2 cannot forget the ceiling; the value is A2's decision
   * and must come with evidence. Callers that pass nothing get no ceiling, and
   * A1 has no production caller.
   */
  readonly maxModelParts?: number;
}

/** Raised when a graph operation cannot proceed. Typed by the caller, not here. */
export interface PackageGraphFailure {
  readonly reason: 'too-many-model-parts';
  readonly loaded: number;
  readonly limit: number;
}

/**
 * The package's loaded model parts, and the rules about loading more.
 *
 * Generic over the reader's parse result so this module never has to know what
 * a model part contains — which keeps the ownership rules testable without a
 * parser, and keeps the parser free of graph concerns.
 */
export class PackageModelGraph<TParsed> {
  public readonly rootKey: ModelPartKey;
  private readonly entries: readonly ZipEntry[];
  private readonly budget: InflationBudget;
  private readonly load: ModelPartLoader<TParsed>;
  private readonly maxModelParts: number | undefined;
  private readonly parts = new Map<ModelPartKey, ModelPart<TParsed>>();
  /**
   * In-flight loads, so two references to one part awaited concurrently produce
   * ONE parse rather than two. Without this, parse-once holds only for
   * sequential callers — and the whole reason the graph exists is that a
   * package may name the same part many times.
   */
  private readonly loading = new Map<ModelPartKey, Promise<ModelPart<TParsed>>>();

  public constructor(options: PackageModelGraphOptions<TParsed>) {
    this.rootKey = options.rootKey;
    this.entries = options.entries;
    this.budget = options.budget;
    this.load = options.load;
    this.maxModelParts = options.maxModelParts;
  }

  /** The one budget this package spends. Never a fresh one per part. */
  public get inflationBudget(): InflationBudget {
    return this.budget;
  }

  /** Parts actually loaded — never the count of `.model` entries in the archive. */
  public get loadedCount(): number {
    return this.parts.size;
  }

  public get(key: ModelPartKey): ModelPart<TParsed> | undefined {
    return this.parts.get(key);
  }

  public has(key: ModelPartKey): boolean {
    return this.parts.has(key);
  }

  /** Loaded parts in load order. Reachability order, not directory order. */
  public loaded(): readonly ModelPart<TParsed>[] {
    return [...this.parts.values()];
  }

  /**
   * Returns the part for `key`, parsing it at most once.
   *
   * THE ONLY WAY A PART ENTERS THE GRAPH, which is what makes parse-once a
   * property of the type rather than a habit of its callers. A second request
   * for a loaded part returns the same object; a second request for one still
   * loading awaits the same promise.
   */
  public async ensurePart(
    key: ModelPartKey,
    role: ModelPartRole,
    onFailure: (failure: PackageGraphFailure) => never,
  ): Promise<ModelPart<TParsed>> {
    const existing = this.parts.get(key);
    if (existing !== undefined) return existing;
    const inFlight = this.loading.get(key);
    if (inFlight !== undefined) return inFlight;

    /*
     * CHECKED BEFORE THE PARSE, not after. The ceiling is spent by LOADING, so
     * the only moment at which refusing costs nothing is before the bytes are
     * inflated and scanned — the same reasoning as the part ceiling in
     * `expandBuild`.
     */
    if (this.maxModelParts !== undefined && this.parts.size >= this.maxModelParts) {
      onFailure({
        reason: 'too-many-model-parts',
        loaded: this.parts.size,
        limit: this.maxModelParts,
      });
    }

    const entry = this.entries.find((candidate) => candidate.name.toLowerCase() === key);
    if (entry === undefined) {
      // Callers resolve paths through `resolvePackageModelPath`, which has
      // already proven the entry exists. Reaching here means a key was built
      // some other way, which is a wiring fault rather than a bad file.
      throw new Error(`PackageModelGraph asked for an entry that is not in the archive: ${key}`);
    }

    const pending = this.load(entry, key, role).then(({ parsed, unit }) => {
      const part: ModelPart<TParsed> = { key, role, unit, parsed };
      this.parts.set(key, part);
      this.loading.delete(key);
      return part;
    });
    this.loading.set(key, pending);
    return pending;
  }
}
