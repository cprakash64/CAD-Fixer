import { describe, expect, it } from 'vitest';
import { scanArtifactPaths } from './audit-artifact-paths.mjs';

const options = { username: 'fixtureDeveloper', roots: ['/opt/checkout/private-project'] };
describe('deployment path audit scans text and binary bytes', () => {
  for (const [name, bytes] of [
    ['text', Buffer.from('const source="/Users/example/project";')],
    [
      'binary',
      Buffer.concat([
        Buffer.from([0, 255, 128]),
        Buffer.from('/Users/example/project'),
        Buffer.from([0]),
      ]),
    ],
    [
      'WASM data',
      Buffer.concat([
        Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 11]),
        Buffer.from('/Users/example/project\0'),
      ]),
    ],
    ['UTF-16', Buffer.from('/home/example/project', 'utf16le')],
    ['nested virtual-home checkout', Buffer.from('/home/web_user/private-project/source.cpp')],
    ['temporary root', Buffer.from('/private/tmp/build-A/source.cpp')],
    ['Windows root', Buffer.from('C:\\Users\\example\\project\\source.cpp')],
    [
      'JSON-escaped Windows root',
      Buffer.from(JSON.stringify('C:\\Users\\example\\project\\source.cpp')),
    ],
    ['checkout root', Buffer.from('/opt/checkout/private-project/source.cpp')],
    ['username', Buffer.from('built by fixtureDeveloper')],
  ] as const) {
    it(`rejects ${name}`, () => {
      expect(scanArtifactPaths(bytes, options).length).toBeGreaterThan(0);
    });
  }
  it('permits deliberate logical paths and ordinary binary data', () => {
    const bytes = Buffer.concat([
      Buffer.from([0, 255, 128, 47, 0, 47]),
      Buffer.from(
        '/src/geogram/src/lib/assert.cpp\0https://pybrix.com/assets/kernel.wasm\0/home/web_user\0/^data:/i.test(source)',
      ),
    ]);
    expect(scanArtifactPaths(bytes, options)).toEqual([]);
  });
});
