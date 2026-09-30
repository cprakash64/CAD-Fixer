# IMPORT-CORE-01 — bounded large OBJ import

Status: documented follow-up; not implemented in EXPORT-RC-01.

EXPORT-CORE-01 measured approximately 2,175 MiB renderer lifetime footprint
while re-importing the 267,988,923-byte repaired OBJ. The existing buffered OBJ
import holds decoded text, parser number arrays and reconstructed canonical
geometry. This is an import resource cost, separate from bounded export.

A future stage must qualify bounded/streaming large OBJ import with the
production parser, unchanged geometry preservation, resource budgets,
cancellation, worker ownership and multipart/group/material semantics.
Qualification must include the actual repaired truck OBJ, topology equivalence,
phase-attributed memory and post-replacement cleanup on Apple M1 / 8 GiB.

For v0.6 release qualification, disclose large OBJ import memory as technical
debt. Do not infer that export failed from buffered re-import memory, and do not
claim this follow-up has been solved.
