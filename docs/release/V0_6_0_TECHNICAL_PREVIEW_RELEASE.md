# Pybrix v0.6.0 Technical Preview

**Live product:** <https://pybrix.com>

## Repair workflow

Repair now has one persistent **Repair model** action, concise issue rows,
fixability status, progressive information disclosures and collapsed Advanced
diagnostics. A disabled action explains why no automatic repair is available.
File validity and topology health are described separately. Preview shows what
will change before Apply; a partial result clearly reports remaining issues.

## Large-mesh simple-opening repair

**Fill simple openings** is enabled by default. Large parts can be scanned for
multiple independently safe, simple flat openings, while preserving exact
coordinate identity. Eligible fills and conservative repair share one verified
preview, atomic Apply and Undo. Planning promises only openings admitted by
exact intersection verification. Resource limits, cancellation and protection
against results from a replaced document remain enforced.

The qualified motivating STL has about 2 million triangles (1,988,877), 13 open
boundaries, 155 non-manifold vertices and 39 components. Two openings are
repairable; four otherwise-simple openings are refused because their patches
would overlap existing opposite-facing geometry. The two fills append six
facets and leave 11 boundaries, with the other counts unchanged. This is a
truthful partial repair, not a claim that the model is fully repaired. Release
qualification must repeat the local hardware-Chromium journey and STL round trip
on the frozen artifact before production activation.

## Bounded large OBJ export

Large OBJ exports stream directly to a folder you choose, using 256 KiB chunks
with one chunk in flight and backpressure. The browser does not retain the
complete serialized output. Choose a filename and explicitly confirm replacement
of an existing file; cancellation or failure before commit preserves that file.
A newly created target is removed after cancellation or failure when its identity
and ownership can be verified. Ordinary small OBJ exports keep the automatic
Blob download workflow.

The original qualified model produces a deterministic 267,988,767-byte OBJ;
after the two fills it produces 267,988,923 bytes. Native large-file export is
qualified on desktop Chromium with the required directory and transactional
filesystem capability. If that capability is unavailable, large export refuses
before serialization rather than falling back to an output-sized Blob.

Large OBJ **import** remains buffered and memory-heavy: re-importing this model
has used approximately 2.1–2.5 GiB of renderer memory. Bounded export does not
imply bounded import. See [IMPORT-CORE-01](../design/IMPORT_CORE_01.md) for the
planned streaming import follow-up.

## Convert

The primary Convert action stays reachable in short windows. Export refusal
details are progressively disclosed, and an impossible 3MF export is remembered
for the same model revision, format and unit. Changing these inputs re-evaluates
export; changing format recovers the action. The Convert test race corrected in
the qualified ancestry is included.

## Privacy and browser policy

Model processing runs locally in your browser. Models are not uploaded to the
server. The release policy remains desktop Chromium-based browsers with at
least 8 GiB memory; Safari, Firefox and physical mobile devices are not release
qualified. See [browser support](BROWSER_SUPPORT.md) and the
[format support matrix](SUPPORT_MATRIX.md).

## Known limitations and safety boundaries

- Branched or complex boundaries are not automatically filled.
- Non-manifold vertex repair is not implemented.
- Non-planar opening reconstruction is not implemented.
- Interacting openings may require another Repair pass.
- A patch that intersects or double-covers existing geometry is refused.
- Large 3MF export can be refused when serialized XML exceeds the 320 MiB
  validation/write policy. The motivating truck is not claimed to support 3MF
  export. STL and OBJ remain export options. This export policy does not remove
  large streamed 3MF import support.
- Large native OBJ export requires the qualified desktop Chromium filesystem
  capability. Large OBJ import remains buffered and memory-heavy.
- Self-intersection diagnostics retain their existing resource limits.
- Split requires an eligible closed manifold solid. Texture operates on one
  flat connected region. Dimensioned connectors and texture require millimetres.
- Hollow, Redo, OBJ polygon triangulation and 3MF materials/colours/textures are
  not implemented. Printer fit and printability are not guaranteed.

## Geogram technical debt

The startup message **"Argument is multiply defined"** is pre-existing: one set
of duplicate `sys` registration messages appears per kernel start and Geogram
ignores the duplicates. The kernel source and WASM are unchanged from v0.5.0;
WASM SHA-256 is
`507ea5e7c9110781e4d90ade507d1b37a7b95b2832b055cb59418bca43399fc3`.
There is no behavior change. These known messages are classified separately
from application errors in smoke tests; any new console error blocks release.
The qualified kernel is not rebuilt merely to silence logging.

## Canonical origin and deployment

The application origin and production monitor default are <https://pybrix.com>.
The static HTML declares `<link rel="canonical" href="https://pybrix.com/">`;
it introduces no script, dynamic hostname decision or CSP change. The legacy
<https://fixcad.thelunai.com> remains a permanent redirect preserving paths and
queries. Historical release evidence retains its original addresses.

Application deployment uses the immutable exact-SHA artifact, verified manifests
and an atomic symlink switch, without changing nginx, DNS, TLS or Certbot.
A fresh Hostinger snapshot must be confirmed before production mutation. Keep
v0.5.0 as the emergency rollback release and retain both releases afterwards.
