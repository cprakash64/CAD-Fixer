import { expect, it } from 'vitest';
import { createBoundedChannel } from './stream-channel';

it.each([true, false])('acknowledges only after consumption, early producer=%s', async (early) => {
  const channel = createBoundedChannel<string>();
  const iterator = channel[Symbol.asyncIterator]();
  let first: Promise<IteratorResult<string>> | undefined;
  if (!early) first = iterator.next();
  let acknowledged = false;
  const sent = channel.send('one').then(() => {
    acknowledged = true;
  });
  expect((await (first ?? iterator.next())).value).toBe('one');
  await Promise.resolve();
  expect(acknowledged).toBe(false);
  await expect(channel.send('two')).rejects.toThrow();
  const next = iterator.next();
  await sent;
  expect(acknowledged).toBe(true);
  channel.end();
  expect((await next).done).toBe(true);
});
it('wakes a producer on parser failure and rejects further sends', async () => {
  const channel = createBoundedChannel<string>();
  const iterator = channel[Symbol.asyncIterator]();
  const first = iterator.next();
  const sent = channel.send('bad');
  await first;
  channel.fail(new Error('malformed'));
  await expect(sent).rejects.toThrow('malformed');
  await expect(channel.send('next')).rejects.toThrow('malformed');
});
