/*
MIT License

Copyright (c) 2026 Shane

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
*/
// What the mock announces to open subscriptions. A resolver or a control publishes a payload on a
// topic; every subscription on that topic hears it, from every client, because there is one state.

type Listener = (payload: unknown) => void;

const topics = new Map<string, Set<Listener>>();

/** Hear a topic until the returned call stops it. */
export const listen = (topic: string, listener: Listener): (() => void) => {
  const set = topics.get(topic) ?? new Set<Listener>();
  set.add(listener);
  topics.set(topic, set);
  return () => {
    set.delete(listener);
  };
};

export const publish = (topic: string, payload: unknown): void => {
  for (const listener of topics.get(topic) ?? []) listener(payload);
};

/**
 * A topic as an async iterator, which is what a GraphQL subscription resolver returns. Payloads
 * that arrive before the consumer asks for them wait in a queue; `return` stops listening.
 */
export const subscribe = <T>(topic: string): AsyncIterableIterator<T> => {
  const queued: T[] = [];
  const waiting: ((result: IteratorResult<T>) => void)[] = [];
  let done = false;
  const stop = listen(topic, (payload) => {
    const next = waiting.shift();
    if (next) next({ done: false, value: payload as T });
    else queued.push(payload as T);
  });
  const finish = (): Promise<IteratorResult<T>> => {
    done = true;
    stop();
    for (const next of waiting.splice(0))
      next({ done: true, value: undefined });
    return Promise.resolve({ done: true, value: undefined });
  };
  const iterator: AsyncIterableIterator<T> = {
    next: () => {
      if (done) return Promise.resolve({ done: true, value: undefined });
      const value = queued.shift();
      if (value !== undefined) return Promise.resolve({ done: false, value });
      return new Promise((resolve) => waiting.push(resolve));
    },
    return: finish,
    [Symbol.asyncIterator]: () => iterator,
    throw: async (error: unknown) => {
      await finish();
      throw error;
    },
  };
  return iterator;
};

/** The core topic every open connection hears when sessions end (Start fresh, expire). */
export const SESSIONS_ENDED = "mock:sessions-ended";
