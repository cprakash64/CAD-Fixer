import type { FormatReadContext } from '../context';
import type { DocumentReadResult, DocumentReader } from '../document-reader';
import { MeshFormatId } from '../formats';
import { ThreeMfIngestion } from './ingestion-route';
import { read3mf, type ThreeMfReadOptions } from './threemf-reader';

/**
 * A 3MF codec in the shape the format registry expects, reading with fixed
 * options — Stage 6E-A2, routed since 6E-A3.
 *
 * THE PRODUCT'S ONE CHOICE ABOUT INGESTION IS MADE HERE, AND NOWHERE ELSE. The
 * registry holds `threeMfReader`, built with `auto`: every model entry takes
 * the path its declared size selects (`routeModelEntryIngestion`), under the
 * production limits, which A3 did not move. A reader built with anything else
 * exists only where a test or qualification harness constructs one and hands
 * it to `createModelImportHandler` explicitly; the shipped worker never does,
 * and a boundary test asserts that.
 *
 * `read3mf`'s OWN default stays buffered, which is not an inconsistency: it
 * keeps v0.2.0's behaviour as the oracle every differential holds the routed
 * and streamed paths to, and it keeps the product's choice to one visible line
 * rather than spread across a default.
 */
export function createThreeMfReader(options: ThreeMfReadOptions): DocumentReader {
  const fixed: ThreeMfReadOptions = Object.freeze({ ...options });
  return {
    formatId: MeshFormatId.ThreeMf,
    read(bytes: Uint8Array, context: FormatReadContext): Promise<DocumentReadResult> {
      return read3mf(bytes, context, fixed);
    },
  };
}

/** The 3MF codec the product registers: routed per entry, production limits. */
export const threeMfReader: DocumentReader = createThreeMfReader({
  ingestion: ThreeMfIngestion.Auto,
});
