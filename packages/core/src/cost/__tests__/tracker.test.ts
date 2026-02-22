import { describe, it, expect } from 'vitest';
import { CostTracker } from '../tracker.js';

describe('CostTracker', () => {
  it('setAgentUsage sets cumulative usage for an agent', () => {
    const tracker = new CostTracker();
    tracker.setAgentUsage('agent-1', 'claude-sonnet-4-6', { input_tokens: 100, output_tokens: 50 });
    const usage = tracker.getTotalUsage();
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(50);
  });

  it('setAgentUsage replaces previous value (not accumulate)', () => {
    const tracker = new CostTracker();
    tracker.setAgentUsage('agent-1', 'claude-sonnet-4-6', { input_tokens: 100, output_tokens: 50 });
    tracker.setAgentUsage('agent-1', 'claude-sonnet-4-6', { input_tokens: 200, output_tokens: 100 });
    const usage = tracker.getTotalUsage();
    expect(usage.input_tokens).toBe(200);
    expect(usage.output_tokens).toBe(100);
  });

  it('addUsage accumulates tokens in global bucket', () => {
    const tracker = new CostTracker();
    tracker.addUsage('claude-sonnet-4-6', { input_tokens: 100, output_tokens: 50 });
    tracker.addUsage('claude-sonnet-4-6', { input_tokens: 200, output_tokens: 100 });
    const usage = tracker.getTotalUsage();
    expect(usage.input_tokens).toBe(300);
    expect(usage.output_tokens).toBe(150);
  });

  it('getTotalCost calculates using correct model pricing', () => {
    const tracker = new CostTracker();
    // Sonnet 4.6: $3/MTok input, $15/MTok output
    tracker.setAgentUsage('agent-1', 'claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 100_000 });
    const cost = tracker.getTotalCost();
    expect(cost.inputCost).toBeCloseTo(3.0);
    expect(cost.outputCost).toBeCloseTo(1.5);
    expect(cost.totalCost).toBeCloseTo(4.5);
  });

  it('getTotalCost handles mixed models correctly', () => {
    const tracker = new CostTracker();
    // Sonnet 4.6: $3/MTok input, $15/MTok output
    tracker.setAgentUsage('agent-1', 'claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 0 });
    // GPT-5.2: $1.75/MTok input, $14/MTok output
    tracker.setAgentUsage('agent-2', 'gpt-5.2', { input_tokens: 1_000_000, output_tokens: 0 });
    const cost = tracker.getTotalCost();
    expect(cost.totalCost).toBeCloseTo(4.75); // $3 + $1.75
  });

  it('getAgentCost returns cost for specific agent', () => {
    const tracker = new CostTracker();
    tracker.setAgentUsage('agent-1', 'claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 0 });
    expect(tracker.getAgentCost('agent-1')).toBeCloseTo(3.0);
    expect(tracker.getAgentCost('nonexistent')).toBe(0);
  });

  it('getCallCount tracks API calls', () => {
    const tracker = new CostTracker();
    expect(tracker.getCallCount()).toBe(0);
    tracker.setAgentUsage('agent-1', 'model', { input_tokens: 10, output_tokens: 5 });
    tracker.setAgentUsage('agent-1', 'model', { input_tokens: 20, output_tokens: 10 });
    expect(tracker.getCallCount()).toBe(2);
  });

  it('isOverBudget returns true when token limit exceeded', () => {
    const tracker = new CostTracker();
    tracker.setBudget({ maxTokens: 100 });
    tracker.setAgentUsage('agent-1', 'model', { input_tokens: 60, output_tokens: 50 });
    expect(tracker.isOverBudget()).toBe(true);
  });

  it('isOverBudget returns true when cost limit exceeded', () => {
    const tracker = new CostTracker();
    tracker.setBudget({ maxCostUsd: 1.0 });
    // Sonnet 4.6: $3/MTok input + $15/MTok output => $4.5 total
    tracker.setAgentUsage('agent-1', 'claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 100_000 });
    expect(tracker.isOverBudget()).toBe(true);
  });

  it('isOverBudget returns false when within limits', () => {
    const tracker = new CostTracker();
    tracker.setBudget({ maxTokens: 1000, maxCostUsd: 10.0 });
    tracker.setAgentUsage('agent-1', 'model', { input_tokens: 10, output_tokens: 5 });
    expect(tracker.isOverBudget()).toBe(false);
  });

  it('getBudgetStatus returns complete status', () => {
    const tracker = new CostTracker();
    tracker.setBudget({ maxTokens: 1000 });
    tracker.setAgentUsage('agent-1', 'model', { input_tokens: 100, output_tokens: 50 });
    const status = tracker.getBudgetStatus();
    expect(status.usage.input_tokens).toBe(100);
    expect(status.budget.maxTokens).toBe(1000);
    expect(status.remaining.tokens).toBe(850);
    expect(status.overBudget).toBe(false);
  });

  it('resetAgent clears one agent', () => {
    const tracker = new CostTracker();
    tracker.setAgentUsage('agent-1', 'model', { input_tokens: 100, output_tokens: 50 });
    tracker.setAgentUsage('agent-2', 'model', { input_tokens: 200, output_tokens: 100 });
    tracker.resetAgent('agent-1');
    const usage = tracker.getTotalUsage();
    expect(usage.input_tokens).toBe(200);
    expect(usage.output_tokens).toBe(100);
  });

  it('reset clears all tracking', () => {
    const tracker = new CostTracker();
    tracker.setAgentUsage('agent-1', 'model', { input_tokens: 100, output_tokens: 50 });
    tracker.setBudget({ maxTokens: 1000 });
    tracker.reset();
    expect(tracker.getTotalUsage().input_tokens).toBe(0);
    expect(tracker.getCallCount()).toBe(0);
    expect(tracker.getBudgetStatus().budget.maxTokens).toBeUndefined();
  });

  it('accumulates cache tokens via setAgentUsage', () => {
    const tracker = new CostTracker();
    tracker.setAgentUsage('agent-1', 'model', { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 });
    const usage = tracker.getTotalUsage();
    expect(usage.cache_creation_input_tokens).toBe(10);
    expect(usage.cache_read_input_tokens).toBe(5);
  });

  it('getPerAgentUsage returns per-agent data', () => {
    const tracker = new CostTracker();
    tracker.setAgentUsage('agent-1', 'claude-sonnet-4-6', { input_tokens: 100, output_tokens: 50 });
    tracker.setAgentUsage('agent-2', 'gpt-5.2', { input_tokens: 200, output_tokens: 100 });
    const perAgent = tracker.getPerAgentUsage();
    expect(perAgent.size).toBe(2);
    expect(perAgent.get('agent-1')?.model).toBe('claude-sonnet-4-6');
    expect(perAgent.get('agent-2')?.model).toBe('gpt-5.2');
  });

  it('sums usage across multiple agents', () => {
    const tracker = new CostTracker();
    tracker.setAgentUsage('agent-1', 'model', { input_tokens: 100, output_tokens: 50 });
    tracker.setAgentUsage('agent-2', 'model', { input_tokens: 300, output_tokens: 150 });
    const usage = tracker.getTotalUsage();
    expect(usage.input_tokens).toBe(400);
    expect(usage.output_tokens).toBe(200);
  });
});
