import { describe, it, expect, vi } from 'vitest';
import { createCallbackList } from '../event-emitter.js';

describe('createCallbackList', () => {
  it('invokes registered callbacks with the argument', () => {
    const list = createCallbackList<string>();
    const cb = vi.fn();
    list.add(cb);
    list.invoke('hello');
    expect(cb).toHaveBeenCalledWith('hello');
  });

  it('invokes multiple callbacks in order', () => {
    const list = createCallbackList<number>();
    const order: number[] = [];
    list.add(() => order.push(1));
    list.add(() => order.push(2));
    list.add(() => order.push(3));
    list.invoke(42);
    expect(order).toEqual([1, 2, 3]);
  });

  it('returns an unsubscribe function from add()', () => {
    const list = createCallbackList<string>();
    const cb = vi.fn();
    const unsub = list.add(cb);
    unsub();
    list.invoke('should not fire');
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe only removes the specific callback', () => {
    const list = createCallbackList<string>();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const unsub1 = list.add(cb1);
    list.add(cb2);

    unsub1();
    list.invoke('test');

    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledWith('test');
  });

  it('handles unsubscribe called multiple times gracefully', () => {
    const list = createCallbackList<string>();
    const cb = vi.fn();
    const unsub = list.add(cb);
    unsub();
    unsub(); // Should not throw
    list.invoke('test');
    expect(cb).not.toHaveBeenCalled();
  });

  it('isolates errors: one failing callback does not break others', () => {
    const list = createCallbackList<string>();
    const cb1 = vi.fn(() => { throw new Error('cb1 error'); });
    const cb2 = vi.fn();
    const cb3 = vi.fn(() => { throw new Error('cb3 error'); });

    list.add(cb1);
    list.add(cb2);
    list.add(cb3);

    // Should not throw
    list.invoke('test');

    expect(cb1).toHaveBeenCalledWith('test');
    expect(cb2).toHaveBeenCalledWith('test');
    expect(cb3).toHaveBeenCalledWith('test');
  });

  it('works with no callbacks registered', () => {
    const list = createCallbackList<string>();
    // Should not throw
    list.invoke('no-one-listening');
  });

  it('works with null/undefined argument types', () => {
    const list = createCallbackList<null>();
    const cb = vi.fn();
    list.add(cb);
    list.invoke(null);
    expect(cb).toHaveBeenCalledWith(null);
  });

  it('works with complex object arguments', () => {
    interface Agent { id: string; name: string }
    const list = createCallbackList<Agent | null>();
    const cb = vi.fn();
    list.add(cb);

    list.invoke({ id: 'a1', name: 'Test' });
    expect(cb).toHaveBeenCalledWith({ id: 'a1', name: 'Test' });

    list.invoke(null);
    expect(cb).toHaveBeenCalledWith(null);
  });

  it('supports adding callbacks after invoke', () => {
    const list = createCallbackList<number>();
    list.invoke(1); // No listeners, no error

    const cb = vi.fn();
    list.add(cb);
    list.invoke(2);
    expect(cb).toHaveBeenCalledWith(2);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('logs errors to console.error', () => {
    const list = createCallbackList<string>();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    list.add(() => { throw new Error('test error'); });
    list.invoke('x');

    expect(errorSpy).toHaveBeenCalledWith(
      '[CallbackList] callback error:',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
