import { describe, it, expect, vi } from 'vitest';
import { CostTracker } from '../tracker.js';
import type { ProviderAdapter, CostEstimate } from '../../types/provider.js';
import type { TokenUsage } from '../../types/messages.js';

function createMockAdapter(): ProviderAdapter {
  return {
    id: 'mock',
    buildRequest: vi.fn() as any,
    parseSSEEvent: vi.fn() as any,
    extractUsage: vi.fn() as any,
    estimateCost: vi.fn((model: string, usage: TokenUsage): CostEstimate => {
      // Simple mock: $3/MTok input, $15/MTok output (like Sonnet 4)
      const inputCost = (usage.input_tokens / 1_000_000) * 3.0;
      const outputCost = (usage.output_tokens / 1_000_000) * 15.0;
      return { inputCost, outputCost, totalCost: inputCost + outputCost, currency: 'USD' };
    }),
    resetState: vi.fn(),
  };
}

describe('CostTracker', () => {
  it('addUsage accumulates tokens correctly', () => {
    const tracker = new CostTracker(createMockAdapter());
    tracker.addUsage('claude-sonnet-4-20250514', { input_tokens: 100, output_tokens: 50 });
    tracker.addUsage('claude-sonnet-4-20250514', { input_tokens: 200, output_tokens: 100 });
    const usage = tracker.getTotalUsage();
    expect(usage.input_tokens).toBe(300);
    expect(usage.output_tokens).toBe(150);
  });

  it('getTotalCost calculates correctly', () => {
    const tracker = new CostTracker(createMockAdapter());
    tracker.addUsage('claude-sonnet-4-20250514', { input_tokens: 1_000_000, output_tokens: 100_000 });
    const cost = tracker.getTotalCost();
    expect(cost.inputCost).toBeCloseTo(3.0);
    expect(cost.outputCost).toBeCloseTo(1.5);
    expect(cost.totalCost).toBeCloseTo(4.5);
  });

  it('getCallCount tracks API calls', () => {
    const tracker = new CostTracker(createMockAdapter());
    expect(tracker.getCallCount()).toBe(0);
    tracker.addUsage('model', { input_tokens: 10, output_tokens: 5 });
    tracker.addUsage('model', { input_tokens: 20, output_tokens: 10 });
    expect(tracker.getCallCount()).toBe(2);
  });

  it('isOverBudget returns true when token limit exceeded', () => {
    const tracker = new CostTracker(createMockAdapter());
    tracker.setBudget({ maxTokens: 100 });
    tracker.addUsage('model', { input_tokens: 60, output_tokens: 50 });
    expect(tracker.isOverBudget()).toBe(true);
  });

  it('isOverBudget returns true when cost limit exceeded', () => {
    const tracker = new CostTracker(createMockAdapter());
    tracker.setBudget({ maxCostUsd: 1.0 });
    tracker.addUsage('claude-sonnet-4-20250514', { input_tokens: 1_000_000, output_tokens: 100_000 });
    // Cost is $4.5, over $1.0 budget
    expect(tracker.isOverBudget()).toBe(true);
  });

  it('isOverBudget returns false when within limits', () => {
    const tracker = new CostTracker(createMockAdapter());
    tracker.setBudget({ maxTokens: 1000, maxCostUsd: 10.0 });
    tracker.addUsage('model', { input_tokens: 10, output_tokens: 5 });
    expect(tracker.isOverBudget()).toBe(false);
  });

  it('getBudgetStatus returns complete status', () => {
    const tracker = new CostTracker(createMockAdapter());
    tracker.setBudget({ maxTokens: 1000 });
    tracker.addUsage('model', { input_tokens: 100, output_tokens: 50 });
    const status = tracker.getBudgetStatus();
    expect(status.usage.input_tokens).toBe(100);
    expect(status.budget.maxTokens).toBe(1000);
    expect(status.remaining.tokens).toBe(850);
    expect(status.overBudget).toBe(false);
  });

  it('reset clears all tracking', () => {
    const tracker = new CostTracker(createMockAdapter());
    tracker.addUsage('model', { input_tokens: 100, output_tokens: 50 });
    tracker.setBudget({ maxTokens: 1000 });
    tracker.reset();
    expect(tracker.getTotalUsage().input_tokens).toBe(0);
    expect(tracker.getCallCount()).toBe(0);
    expect(tracker.getBudgetStatus().budget.maxTokens).toBeUndefined();
  });

  it('accumulates cache tokens', () => {
    const tracker = new CostTracker(createMockAdapter());
    tracker.addUsage('model', { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10 });
    tracker.addUsage('model', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 5 });
    const usage = tracker.getTotalUsage();
    expect(usage.cache_creation_input_tokens).toBe(10);
    expect(usage.cache_read_input_tokens).toBe(5);
  });
});
