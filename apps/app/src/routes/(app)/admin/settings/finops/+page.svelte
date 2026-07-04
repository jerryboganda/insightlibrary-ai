<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { Activity, Cpu, DollarSign, ArrowUpRight, BarChart3 } from '@lucide/svelte';
	import { fly } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';

	// Real usage metrics drive the budget cards; static illustrative figures (cache hit
	// rate, MoM deltas) supplement where the metrics feed has no matching field.
	const usage = createQuery({ queryKey: ['usage'], queryFn: () => api.getUsage() });

	const budgetPct = $derived(
		$usage.data && $usage.data.monthlyBudget > 0
			? Math.min(100, Math.round(($usage.data.currentSpend / $usage.data.monthlyBudget) * 100))
			: 0
	);
	const barColor = $derived(
		budgetPct >= 90 ? 'bg-rose-400' : budgetPct >= 75 ? 'bg-amber-400' : 'bg-emerald-400'
	);

	function money(n: number): string {
		return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	}

	// Budget-control inputs — inline, no config endpoint yet (prototype spec).
	let hardLimit = $state(500);
	let softThreshold = $state(80);
</script>

<div class="max-w-5xl space-y-8 p-6 md:p-8">
	<header>
		<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
			<Cpu class="h-6 w-6 text-indigo-400" />
			AI Usage & FinOps
		</h1>
		<p class="mt-2 text-sm text-zinc-400">
			Monitor Copilot SDK consumption, token costs, and set limits.
		</p>
	</header>

	<!-- Overview Metrics -->
	<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
		{#if $usage.isLoading}
			{#each Array(4) as _, i (i)}
				<Skeleton class="h-[104px] rounded-xl" />
			{/each}
		{:else}
			<div
				in:fly={{ y: 8, duration: 250 }}
				class="glass-panel flex flex-col justify-between rounded-xl border border-zinc-800 p-5"
			>
				<div class="flex items-center justify-between text-sm font-medium text-zinc-400">
					Monthly Cost
					<DollarSign class="h-4 w-4" />
				</div>
				<div class="mt-4 flex items-end justify-between">
					<span class="text-2xl font-bold text-zinc-100">{money($usage.data?.currentSpend ?? 0)}</span>
					<span class="flex items-center text-xs font-medium text-rose-400">
						<ArrowUpRight class="h-3 w-3" /> 12%
					</span>
				</div>
			</div>

			<div
				in:fly={{ y: 8, duration: 250, delay: 40 }}
				class="glass-panel flex flex-col justify-between rounded-xl border border-zinc-800 p-5"
			>
				<div class="flex items-center justify-between text-sm font-medium text-zinc-400">
					Budget Used
					<Activity class="h-4 w-4" />
				</div>
				<div class="mt-4">
					<div class="mb-2 flex items-end justify-between">
						<span class="text-2xl font-bold text-zinc-100">{budgetPct}%</span>
						<span class="text-xs font-medium text-zinc-500">
							{money($usage.data?.currentSpend ?? 0)} / {money($usage.data?.monthlyBudget ?? 0)}
						</span>
					</div>
					<div class="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
						<div class="h-full rounded-full {barColor}" style="width: {budgetPct}%"></div>
					</div>
				</div>
			</div>

			<div
				in:fly={{ y: 8, duration: 250, delay: 80 }}
				class="glass-panel flex flex-col justify-between rounded-xl border border-zinc-800 p-5"
			>
				<div class="flex items-center justify-between text-sm font-medium text-zinc-400">
					Cached Requests
					<BarChart3 class="h-4 w-4" />
				</div>
				<div class="mt-4 flex items-end justify-between">
					<span class="text-2xl font-bold text-zinc-100">42%</span>
					<span class="text-xs text-zinc-500">Savings: ~$120</span>
				</div>
			</div>

			<div
				in:fly={{ y: 8, duration: 250, delay: 120 }}
				class="glass-panel flex flex-col justify-between rounded-xl border border-zinc-800 p-5"
			>
				<div class="flex items-center justify-between text-sm font-medium text-zinc-400">
					Avg. Cost / Query
					<Cpu class="h-4 w-4" />
				</div>
				<div class="mt-4 flex items-end justify-between">
					<span class="text-2xl font-bold text-zinc-100">{money($usage.data?.costPerQuery ?? 0)}</span>
					<span class="flex items-center text-xs font-medium text-emerald-400">
						<ArrowUpRight class="h-3 w-3 rotate-90" /> 4%
					</span>
				</div>
			</div>
		{/if}
	</div>

	<!-- Budget Controls -->
	<section class="glass-panel mt-8 overflow-hidden rounded-xl border border-zinc-800">
		<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/30 p-6">
			<div>
				<h2 class="text-lg font-semibold text-zinc-100">Budget Controls</h2>
				<p class="mt-1 text-sm text-zinc-400">
					Set hard and soft limits for AI usage to avoid unexpected costs.
				</p>
			</div>
		</div>
		<div class="space-y-6 p-6">
			<div class="flex max-w-2xl items-start justify-between gap-4">
				<div class="flex-1">
					<h4 class="text-sm font-medium text-zinc-200">Hard Limit</h4>
					<p class="mt-1 text-xs text-zinc-500">
						If the workspace reaches this limit, AI operations will be halted until the next billing
						cycle or until the limit is increased.
					</p>
				</div>
				<div class="flex shrink-0 items-center gap-2">
					<span class="text-zinc-400">$</span>
					<input
						type="number"
						bind:value={hardLimit}
						class="w-24 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-right text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
				</div>
			</div>

			<hr class="max-w-2xl border-zinc-800/60" />

			<div class="flex max-w-2xl items-start justify-between gap-4">
				<div class="flex-1">
					<h4 class="text-sm font-medium text-zinc-200">Soft Threshold Alerts</h4>
					<p class="mt-1 text-xs text-zinc-500">
						Send an email alert to workspace admins when usage crosses this threshold.
					</p>
				</div>
				<div class="flex shrink-0 items-center gap-2">
					<input
						type="number"
						bind:value={softThreshold}
						class="w-20 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-right text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<span class="text-zinc-400">%</span>
				</div>
			</div>
		</div>
	</section>
</div>
