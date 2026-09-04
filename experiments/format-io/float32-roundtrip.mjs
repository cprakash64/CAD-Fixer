/**
 * Stage 4A-1 — how many decimal digits does a Float32 need to survive text?
 * RESEARCH ONLY.
 *
 * WHY THIS IS NOT A STYLE QUESTION. OBJ and 3MF write coordinates as decimal
 * text. Canonical geometry is Float32. If the writer emits too few digits the
 * value that comes back is a DIFFERENT float, and every exactness guarantee the
 * product makes — exact stored-coordinate topology, no-tolerance repair, exact
 * self-intersection classification — is silently violated by the exporter. A
 * "six decimal places looks fine" choice would be the single cheapest way to
 * undo three stages of work.
 *
 * The claim under test: 9 significant digits round-trips every Float32 exactly.
 */

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

const roundTrip = (value, format) => {
  f32[0] = value;
  const original = f32[0];
  const text = format(original);
  f32[0] = Number.parseFloat(text);
  return { ok: Object.is(f32[0], original), text };
};

/** Every strategy a writer might plausibly choose. */
const strategies = {
  'toFixed(6)': (v) => v.toFixed(6),
  'toPrecision(7)': (v) => Number(v.toPrecision(7)).toString(),
  'toPrecision(8)': (v) => Number(v.toPrecision(8)).toString(),
  'toPrecision(9)': (v) => Number(v.toPrecision(9)).toString(),
  'String(v)': (v) => String(v),
};

/** Deterministic PRNG so the corpus is reproducible. */
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function corpus() {
  const values = [];
  // Hand-picked boundaries: the cases a random sweep is least likely to hit.
  const named = [
    0,
    -0,
    1,
    -1,
    0.1,
    -0.1,
    1.401298464324817e-45, // smallest subnormal Float32
    1.1754943508222875e-38, // smallest normal Float32
    3.4028234663852886e38, // largest finite Float32
    -3.4028234663852886e38,
    1 / 3,
    2 / 3,
    Math.PI,
    Math.E,
    16777216,
    16777217, // Float32 integer precision boundary
    1e-7,
    1e7,
    123456.789,
  ];
  for (const v of named) values.push({ label: 'named', value: v });

  // Uniform random BIT PATTERNS, not random reals: this reaches subnormals and
  // exponent extremes that a `Math.random() * range` sweep never produces.
  const rand = mulberry32(0x4a10);
  let drawn = 0;
  while (drawn < 200_000) {
    u32[0] = (rand() * 4294967296) >>> 0;
    const v = f32[0];
    if (!Number.isFinite(v)) continue; // NaN/Inf are rejected at import, not written
    values.push({ label: 'random-bits', value: v });
    drawn += 1;
  }
  return values;
}

const values = corpus();
process.stdout.write(
  `corpus: ${values.length} finite Float32 values (17 named + 200,000 random bit patterns)\n\n`,
);
process.stdout.write(
  `${'strategy'.padEnd(16)} ${'exact'.padStart(9)} ${'failed'.padStart(8)}  ${'avg chars'.padStart(9)}  first failure\n`,
);

for (const [name, format] of Object.entries(strategies)) {
  let exact = 0;
  let failed = 0;
  let chars = 0;
  let firstFailure = '';
  for (const { value } of values) {
    const { ok, text } = roundTrip(value, format);
    chars += text.length;
    if (ok) exact += 1;
    else {
      failed += 1;
      if (firstFailure === '') firstFailure = `${String(value)} -> "${text}"`;
    }
  }
  process.stdout.write(
    `${name.padEnd(16)} ${String(exact).padStart(9)} ${String(failed).padStart(8)}  ` +
      `${(chars / values.length).toFixed(1).padStart(9)}  ${firstFailure.slice(0, 44)}\n`,
  );
}

// Negative zero deserves its own answer: it round-trips as a VALUE but many
// writers emit "0" for it, and -0 vs 0 is observable through Object.is and
// through division. The exporter must decide deliberately.
f32[0] = -0;
process.stdout.write(
  `\nnegative zero: String(-0) = "${String(f32[0])}", toPrecision(9) = "${Number((-0).toPrecision(9)).toString()}", ` +
    `parses back to ${Object.is(Number.parseFloat(String(-0)), -0) ? '-0 (preserved)' : '+0 (LOST)'}\n`,
);
