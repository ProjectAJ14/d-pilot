import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startReachabilityWatch } from "./server-reachability";

/** A watch whose ping and `online` listener are under the test's control. */
function setup(ping: () => Promise<boolean>) {
  let online: (() => void) | null = null;
  const onRecovered = vi.fn();
  const removeOnline = vi.fn(() => (online = null));
  const stop = startReachabilityWatch({
    ping,
    onRecovered,
    intervalMs: 10_000,
    addOnline: (cb) => (online = cb),
    removeOnline,
  });
  return { stop, onRecovered, removeOnline, fireOnline: () => online?.() };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startReachabilityWatch", () => {
  it("pings once per interval while the server stays down", async () => {
    const ping = vi.fn(async () => false);
    const { stop } = setup(ping);
    expect(ping).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ping).toHaveBeenCalledTimes(3);
    stop();
  });

  it("stops polling and calls back on the first successful ping", async () => {
    const ping = vi.fn(async () => true);
    const { onRecovered, removeOnline } = setup(ping);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onRecovered).toHaveBeenCalledOnce();
    expect(removeOnline).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(ping).toHaveBeenCalledOnce();
    expect(onRecovered).toHaveBeenCalledOnce();
  });

  it("pings at once on the browser's online event", async () => {
    const ping = vi.fn(async () => false);
    const { fireOnline, stop } = setup(ping);
    fireOnline();
    expect(ping).toHaveBeenCalledOnce();
    stop();
  });

  it("stop() clears the interval and the online listener", async () => {
    const ping = vi.fn(async () => false);
    const { stop, removeOnline, fireOnline } = setup(ping);
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeOnline).toHaveBeenCalledOnce();
    fireOnline();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ping).not.toHaveBeenCalled();
  });

  it("never starts a ping while one is still in flight", async () => {
    let answer!: (ok: boolean) => void;
    const ping = vi.fn(() => new Promise<boolean>((r) => (answer = r)));
    const { fireOnline, onRecovered } = setup(ping);
    await vi.advanceTimersByTimeAsync(10_000);
    fireOnline();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ping).toHaveBeenCalledOnce();
    answer(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ping).toHaveBeenCalledTimes(2);
    answer(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(onRecovered).toHaveBeenCalledOnce();
  });
});
