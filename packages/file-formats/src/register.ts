import { registerReader, registerWriter } from './registry';
import { stlReader, stlWriter } from './stl/codec';

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
  registerWriter(stlWriter);
}
