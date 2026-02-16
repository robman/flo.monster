import type { TokenUsage } from '../types/messages.js';
import type { ProviderAdapter, CostEstimate } from '../types/provider.js';
import { accumulateUsage } from '../utils/tokens.js';

export interface Budget {
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface BudgetStatus {
  usage: TokenUsage;
  cost: CostEstimate;
  budget: Budget;
  remaining: {
    tokens?: number;
    costUsd?: number;
  };
  overBudget: boolean;
}

export class CostTracker {
  private adapter: ProviderAdapter;
  private totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
  private budget: Budget = {};
  private callCount = 0;
  private model = '';

  constructor(adapter: ProviderAdapter) {
    this.adapter = adapter;
  }

  addUsage(model: string, usage: TokenUsage): void {
    this.model = model;
    this.callCount++;
    this.totalUsage = accumulateUsage(this.totalUsage, usage);
  }

  getTotalUsage(): TokenUsage {
    return { ...this.totalUsage };
  }

  getTotalCost(): CostEstimate {
    return this.adapter.estimateCost(this.model, this.totalUsage);
  }

  getCallCount(): number {
    return this.callCount;
  }

  setBudget(budget: Budget): void {
    this.budget = { ...budget };
  }

  isOverBudget(): boolean {
    const totalTokens = this.totalUsage.input_tokens + this.totalUsage.output_tokens;
    if (this.budget.maxTokens !== undefined && totalTokens >= this.budget.maxTokens) {
      return true;
    }
    if (this.budget.maxCostUsd !== undefined) {
      const cost = this.getTotalCost();
      if (cost.totalCost >= this.budget.maxCostUsd) {
        return true;
      }
    }
    return false;
  }

  getBudgetStatus(): BudgetStatus {
    const totalTokens = this.totalUsage.input_tokens + this.totalUsage.output_tokens;
    const cost = this.getTotalCost();
    return {
      usage: this.getTotalUsage(),
      cost,
      budget: { ...this.budget },
      remaining: {
        tokens: this.budget.maxTokens !== undefined ? Math.max(0, this.budget.maxTokens - totalTokens) : undefined,
        costUsd: this.budget.maxCostUsd !== undefined ? Math.max(0, this.budget.maxCostUsd - cost.totalCost) : undefined,
      },
      overBudget: this.isOverBudget(),
    };
  }

  reset(): void {
    this.totalUsage = { input_tokens: 0, output_tokens: 0 };
    this.budget = {};
    this.callCount = 0;
    this.model = '';
  }
}
