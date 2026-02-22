import type { TokenUsage } from '../types/messages.js';
import type { CostEstimate } from '../types/provider.js';
import { estimateCostForModel } from '../adapters/cost-utils.js';
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
  private perAgentUsage = new Map<string, { model: string; usage: TokenUsage }>();
  private budget: Budget = {};
  private callCount = 0;

  /**
   * Set cumulative usage for an agent. Replaces any previous value.
   * Use this for usage events that report cumulative totals (both browser worker and hub).
   */
  setAgentUsage(agentId: string, model: string, usage: TokenUsage): void {
    this.perAgentUsage.set(agentId, { model, usage: { ...usage } });
    this.callCount++;
  }

  /**
   * Legacy: accumulate usage into a global bucket.
   * Used for lifecycle restore where we have a single accumulated total.
   */
  addUsage(model: string, usage: TokenUsage): void {
    const existing = this.perAgentUsage.get('_global');
    if (existing) {
      existing.model = model;
      existing.usage = accumulateUsage(existing.usage, usage);
    } else {
      this.perAgentUsage.set('_global', { model, usage: { ...usage } });
    }
    this.callCount++;
  }

  getTotalUsage(): TokenUsage {
    let total: TokenUsage = { input_tokens: 0, output_tokens: 0 };
    for (const entry of this.perAgentUsage.values()) {
      total = accumulateUsage(total, entry.usage);
    }
    return total;
  }

  getTotalCost(): CostEstimate {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;
    for (const entry of this.perAgentUsage.values()) {
      const cost = estimateCostForModel(entry.model, entry.usage);
      totalInput += cost.inputCost;
      totalOutput += cost.outputCost;
      totalCost += cost.totalCost;
    }
    return { inputCost: totalInput, outputCost: totalOutput, totalCost, currency: 'USD' };
  }

  getAgentCost(agentId: string): number {
    const entry = this.perAgentUsage.get(agentId);
    if (!entry) return 0;
    return estimateCostForModel(entry.model, entry.usage).totalCost;
  }

  getCallCount(): number {
    return this.callCount;
  }

  getPerAgentUsage(): ReadonlyMap<string, { model: string; usage: TokenUsage }> {
    return this.perAgentUsage;
  }

  setBudget(budget: Budget): void {
    this.budget = { ...budget };
  }

  isOverBudget(): boolean {
    const totalUsage = this.getTotalUsage();
    const totalTokens = totalUsage.input_tokens + totalUsage.output_tokens;
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
    const usage = this.getTotalUsage();
    const totalTokens = usage.input_tokens + usage.output_tokens;
    const cost = this.getTotalCost();
    return {
      usage,
      cost,
      budget: { ...this.budget },
      remaining: {
        tokens: this.budget.maxTokens !== undefined ? Math.max(0, this.budget.maxTokens - totalTokens) : undefined,
        costUsd: this.budget.maxCostUsd !== undefined ? Math.max(0, this.budget.maxCostUsd - cost.totalCost) : undefined,
      },
      overBudget: this.isOverBudget(),
    };
  }

  resetAgent(agentId: string): void {
    this.perAgentUsage.delete(agentId);
  }

  reset(): void {
    this.perAgentUsage.clear();
    this.budget = {};
    this.callCount = 0;
  }
}
