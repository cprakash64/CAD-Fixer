import { registerReader, registerWriter } from './registry';
import { objReader } from './obj/codec';
import { stlReader, stlWriter } from './stl/codec';
import { threeMfReader } from './threemf/codec';

/**
 * Registers the codecs that ship with the application.
 *
 * Called explicitly by the worker rather than run as an import side effect:
 * side-effecting module loads interact badly with bundler tree-shaking, and an
 * explicit call makes it obvious where the application's format capabilities
 * come from.
 *
 * Idempotent — registering the same format twice replaces the entry.
 */
export function registerBuiltInFormats(): void {
  registerReader(stlReader);
  registerReader(objReader);
  registerReader(threeMfReader);
  /*
   * ONE WRITER. Export for OBJ and 3MF is Stage 4A-2B2, and registering a stub
   * now would let the interface advertise a Save that cannot happen — a test
   * asserts the capability list matches exactly what registers here.
   */
  registerWriter(stlWriter);
}
