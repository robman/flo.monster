import { describe, it, expect } from 'vitest';
import { CostDisplay } from './cost-display.js';
import type { BudgetStatus } from '@flo-monster/core';

describe('CostDisplay', () => {
  function createDisplay() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const display = new CostDisplay(container);
    return { display, container };
  }

  function makeBudgetStatus(overrides: Partial<BudgetStatus> = {}): BudgetStatus {
    return {
      usage: { input_tokens: 0, output_tokens: 0 },
      cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' },
      budget: {},
      remaining: {},
      overBudget: false,
      ...overrides,
    };
  }

  it('renders token counts and cost', () => {
    const { display, container } = createDisplay();
    display.update(makeBudgetStatus({
      usage: { input_tokens: 1234, output_tokens: 567 },
      cost: { inputCost: 0.01, outputCost: 0.005, totalCost: 0.015, currency: 'USD' },
    }));
    const items = container.querySelectorAll('.status-bar__item');
    expect(items[0].textContent).toContain('1.2K in');
    expect(items[0].textContent).toContain('567 out');
    expect(items[1].textContent).toContain('$0.0150');
  });

  it('updates on new data', () => {
    const { display, container } = createDisplay();
    display.update(makeBudgetStatus({
      usage: { input_tokens: 100, output_tokens: 50 },
      cost: { inputCost: 0, outputCost: 0, totalCost: 0.001, currency: 'USD' },
    }));
    display.update(makeBudgetStatus({
      usage: { input_tokens: 500, output_tokens: 200 },
      cost: { inputCost: 0.01, outputCost: 0.02, totalCost: 0.03, currency: 'USD' },
    }));
    const items = container.querySelectorAll('.status-bar__item');
    expect(items[0].textContent).toContain('500 in');
    expect(items[1].textContent).toContain('$0.0300');
  });

  it('shows budget info when budget is set', () => {
    const { display, container } = createDisplay();
    display.update(makeBudgetStatus({
      usage: { input_tokens: 100, output_tokens: 50 },
      cost: { inputCost: 0, outputCost: 0, totalCost: 0.01, currency: 'USD' },
      budget: { maxTokens: 1000, maxCostUsd: 1.0 },
      remaining: { tokens: 850, costUsd: 0.99 },
    }));
    const items = container.querySelectorAll('.status-bar__item');
    // Budget element should be visible
    expect((items[2] as HTMLElement).style.display).not.toBe('none');
    expect(items[2].textContent).toContain('850 tokens left');
    expect(items[2].textContent).toContain('$0.9900 left');
  });

  it('shows warning when over budget', () => {
    const { display, container } = createDisplay();
    display.update(makeBudgetStatus({
      usage: { input_tokens: 1500, output_tokens: 500 },
      cost: { inputCost: 0.5, outputCost: 0.5, totalCost: 1.0, currency: 'USD' },
      budget: { maxTokens: 1000 },
      remaining: { tokens: 0 },
      overBudget: true,
    }));
    const budgetEl = container.querySelectorAll('.status-bar__item')[2] as HTMLElement;
    expect(budgetEl.className).toContain('budget--critical');
  });

  it('hides budget element when no budget set', () => {
    const { display, container } = createDisplay();
    display.update(makeBudgetStatus());
    const budgetEl = container.querySelectorAll('.status-bar__item')[2] as HTMLElement;
    expect(budgetEl.style.display).toBe('none');
  });

  it('formats large numbers correctly', () => {
    const { display, container } = createDisplay();
    display.update(makeBudgetStatus({
      usage: { input_tokens: 1_500_000, output_tokens: 250_000 },
      cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' },
    }));
    const items = container.querySelectorAll('.status-bar__item');
    expect(items[0].textContent).toContain('1.5M in');
    expect(items[0].textContent).toContain('250.0K out');
  });
});
