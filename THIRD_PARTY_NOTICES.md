# Third-party notices

The index of third-party material that ships inside CAD Fixer's static assets
and is not an npm package, as introduced by the UI-01 shell. The npm runtime
packages (React, React DOM, three.js) and the Geogram kernel are recorded in
[`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md); the vendored Manifold build
carries its licence beside it in `apps/web/src/workers/third-party/manifold/`.

Every entry below keeps its full licence text beside it in the source tree, and
the deployed build carries the same texts in `third-party-notices.txt` at the
site root (source: [`apps/web/public/third-party-notices.txt`](apps/web/public/third-party-notices.txt)).
`scripts/third-party-notices.test.ts` fails if the two ever differ.

| Asset                                                                                            | Licence (SPDX) | Attribution                                                                                        | Source                                 | Full text in tree                                                                              |
| ------------------------------------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Figtree (variable, Latin subset) — `apps/web/src/styles/fonts/figtree-latin.woff2`               | `OFL-1.1`      | Copyright 2022 The Figtree Project Authors (https://github.com/erikdkennedy/figtree)               | Google Fonts distribution, unmodified  | [`apps/web/src/styles/fonts/LICENSE`](apps/web/src/styles/fonts/LICENSE)                       |
| Space Grotesk (variable, Latin subset) — `apps/web/src/styles/fonts/space-grotesk-latin.woff2`   | `OFL-1.1`      | Copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk) | Google Fonts distribution, unmodified  | [`apps/web/src/styles/fonts/LICENSE`](apps/web/src/styles/fonts/LICENSE)                       |
| JetBrains Mono (variable, Latin subset) — `apps/web/src/styles/fonts/jetbrains-mono-latin.woff2` | `OFL-1.1`      | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)     | Google Fonts distribution, unmodified  | [`apps/web/src/styles/fonts/LICENSE`](apps/web/src/styles/fonts/LICENSE)                       |
| Lucide icon path data (≈ 30 icons) — `apps/web/src/components/shell/Icon.tsx`                    | `ISC AND MIT`  | Copyright (c) 2026 Lucide Icons and Contributors; Copyright (c) 2013-present Cole Bemis (Feather)  | https://github.com/lucide-icons/lucide | [`apps/web/src/components/shell/LICENSE-lucide`](apps/web/src/components/shell/LICENSE-lucide) |

The font copyright lines were read from each file's own `name` table; the
Lucide text is its repository's `LICENSE`, verbatim.
