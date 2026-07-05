<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { Activity, Cpu, DollarSign, BarChart3, ShieldAlert } from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';

	// Live usage metering (usage_events ledger) — current calendar month.
	const usage = createQuery({ queryKey: ['usage', 'month'], queryFn: () => api.getUsage('month') });
	// Org settings back the budget controls (budgetMonthlyLimitUsd / budgetSoftThresholdPct).
	const orgSettings = createQuery({ queryKey: ['org-settings'], queryFn: () => api.getOrgSettings() });
	const queryClient = useQueryClient();

	const budget = $derived($usage.data?.budget);
	const spend = $derived(budget?.spendThisMonthUsd ?? $usage.data?.currentSpend ?? 0);
	const limit = $derived(budget?.monthlyLimitUsd ?? 0);
	const budgetPct = $derived(limit > 0 ? Math.min(100, Math.round((spend / limit) * 100)) : 0);
	const barColor = $derived(
		budgetPct >= 90 ? 'bg-rose-400' : budgetPct >= 75 ? 'bg-amber-400' : 'bg-emerald-400'
	);
	const byProvider = $derived(
		[...($usage.data?.byProvider ?? [])].sort((a, b) => b.costUsd - a.costUsd)
	);
	const totalCalls = $derived(byProvider.reduce((t, r) => t + r.calls, 0));

	function money(n: number): string {
		return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	}

	// Budget-control form, seeded once from the persisted org settings.
	let hardLimit = $state(0);
	let softThreshold = $state(80);
	let budgetSeeded = $state(false);
	$effect(() => {
		const s = $orgSettings.data?.settings;
		if (!s || budgetSeeded) return;
		hardLimit = s.budgetMonthlyLimitUsd ?? 0;
		softThreshold = s.budgetSoftThresholdPct ?? 80;
		budgetSeeded = true;
	});

	let savedNotice = $state('');
	let savedTimer: ReturnType<typeof setTimeout> | undefined;
	const saveBudget = createMutation({
		mutationFn: () =>
			api.updateOrgSettings({
				settings: {
					budgetMonthlyLimitUsd: Math.max(0, Number(hardLimit) || 0),
					budgetSoftThresholdPct: Math.min(100, Math.max(0, Number(softThreshold) || 0))
				}
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['org-settings'] });
			queryClient.invalidateQueries({ queryKey: ['usage'] });
			savedNotice = 'Budget saved';
			clearTimeout(savedTimer);
			savedTimer = setTimeout(() => (savedNotice = ''), 3000);
		}
	});
</script>

<div class="max-w-5xl space-y-8 p-6 md:p-8">
	<header>
		<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
			<Cpu class="h-6 w-6 text-indigo-400" />
			AI Usage &amp; FinOps
		</h1>
		<p class="mt-2 text-sm text-zinc-400">
			Live metered AI consumption for the current month, plus workspace budget limits.
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
					Spend This Month
					<DollarSign class="h-4 w-4" />
				</div>
				<div class="mt-4 flex items-end justify-between">
					<span class="text-2xl font-bold text-zinc-100">{money(spend)}</span>
					<span class="text-xs text-zinc-500">estimated</span>
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
					{#if limit > 0}
						<div class="mb-2 flex items-end justify-between">
							<span class="text-2xl font-bold text-zinc-100">{budgetPct}%</span>
							<span class="text-xs font-medium text-zinc-500">{money(spend)} / {money(limit)}</span>
						</div>
						<div class="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
							<div class="h-full rounded-full {barColor}" style="width: {budgetPct}%"></div>
						</div>
					{:else}
						<span class="text-2xl font-bold text-zinc-100">No limit</span>
						<p class="mt-1 text-xs text-zinc-500">Set a hard limit below to enforce a budget.</p>
					{/if}
				</div>
			</div>

			<div
				in:fly={{ y: 8, duration: 250, delay: 80 }}
				class="glass-panel flex flex-col justify-between rounded-xl border border-zinc-800 p-5"
			>
				<div class="flex items-center justify-between text-sm font-medium text-zinc-400">
					Metered AI Calls
					<BarChart3 class="h-4 w-4" />
				</div>
				<div class="mt-4 flex items-end justify-between">
					<span class="text-2xl font-bold text-zinc-100">{totalCalls.toLocaleString()}</span>
					<span class="text-xs text-zinc-500">this month</span>
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
					<span class="text-xs text-zinc-500">estimated</span>
				</div>
			</div>
		{/if}
	</div>

	{#if $usage.data}
		<p class="text-xs text-zinc-600" in:fade={{ duration: 200 }}>
			{#if $usage.data.meteredSince}
				Costs are estimates from metered provider calls since
				{new Date($usage.data.meteredSince).toLocaleDateString()}.
			{:else}
				No AI calls have been metered yet — figures update as the workspace uses AI.
			{/if}
		</p>
	{/if}

	<!-- Provider / model rollup -->
	<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
		<div class="border-b border-zinc-800 bg-zinc-900/30 px-6 py-4">
			<h2 class="text-lg font-semibold text-zinc-100">Cost by Provider &amp; Model</h2>
			<p class="mt-1 text-sm text-zinc-400">Metered calls this month, highest estimated cost first.</p>
		</div>
		{#if $usage.isLoading}
			<div class="space-y-3 p-6">
				{#each Array(3) as _, i (i)}
					<Skeleton class="h-10 rounded-md" />
				{/each}
			</div>
		{:else if byProvider.length === 0}
			<div class="px-6 py-10 text-center text-sm text-zinc-500">No metered provider calls this month.</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-left text-sm">
					<thead class="border-b border-zinc-800/50 bg-zinc-950/80 text-xs font-medium tracking-wider text-zinc-500 uppercase">
						<tr>
							<th class="px-6 py-3">Provider</th>
							<th class="px-6 py-3">Model</th>
							<th class="px-6 py-3 text-right">Calls</th>
							<th class="px-6 py-3 text-right">Tokens In</th>
							<th class="px-6 py-3 text-right">Tokens Out</th>
							<th class="px-6 py-3 text-right">Est. Cost</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-zinc-800/50 text-zinc-300">
						{#each byProvider as row (row.provider + '/' + row.model)}
							<tr class="transition-colors hover:bg-zinc-900/40">
								<td class="px-6 py-3 font-medium text-zinc-200">{row.provider}</td>
								<td class="px-6 py-3 font-mono text-xs text-zinc-400">{row.model || '—'}</td>
								<td class="px-6 py-3 text-right font-mono text-zinc-400">{row.calls.toLocaleString()}</td>
								<td class="px-6 py-3 text-right font-mono text-zinc-400">{row.tokensIn.toLocaleString()}</td>
								<td class="px-6 py-3 text-right font-mono text-zinc-400">{row.tokensOut.toLocaleString()}</td>
								<td class="px-6 py-3 text-right font-mono text-zinc-200">{money(row.costUsd)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<!-- Budget Controls -->
	<section class="glass-panel mt-8 overflow-hidden rounded-xl border border-zinc-800">
		<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/30 p-6">
			<div>
				<h2 class="text-lg font-semibold text-zinc-100">Budget Controls</h2>
				<p class="mt-1 text-sm text-zinc-400">
					Set hard and soft limits for AI usage to avoid unexpected costs.
				</p>
			</div>
			{#if budget?.enforced}
				<span class="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-400">
					<ShieldAlert class="h-3.5 w-3.5" /> Enforced
				</span>
			{/if}
		</div>
		<div class="space-y-6 p-6">
			<div class="flex max-w-2xl items-start justify-between gap-4">
				<div class="flex-1">
					<h4 class="text-sm font-medium text-zinc-200">Hard Limit</h4>
					<p class="mt-1 text-xs text-zinc-500">
						When monthly spend reaches this limit, AI calls billed to the workspace are refused until
						the next month or until the limit is raised. 0 = unlimited.
					</p>
				</div>
				<div class="flex shrink-0 items-center gap-2">
					<span class="text-zinc-400">$</span>
					<input
						type="number"
						min="0"
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
						Record a warning audit event when usage crosses this percentage of the hard limit.
					</p>
				</div>
				<div class="flex shrink-0 items-center gap-2">
					<input
						type="number"
						min="0"
						max="100"
						bind:value={softThreshold}
						class="w-20 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-right text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					/>
					<span class="text-zinc-400">%</span>
				</div>
			</div>
		</div>
		<div class="flex items-center justify-end gap-3 border-t border-zinc-800 bg-zinc-900/30 p-4">
			{#if savedNotice}
				<span in:fade={{ duration: 150 }} class="text-sm font-medium text-emerald-400">{savedNotice}</span>
			{/if}
			{#if $saveBudget.isError}
				<span class="text-xs text-rose-400">
					{$saveBudget.error instanceof Error ? $saveBudget.error.message : 'Save failed'}
				</span>
			{/if}
			<button
				onclick={() => $saveBudget.mutate()}
				disabled={$saveBudget.isPending || $orgSettings.isLoading}
				class="rounded-md border border-indigo-500/50 bg-zinc-950 px-4 py-2 text-sm font-medium text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-40"
			>
				{$saveBudget.isPending ? 'Saving…' : 'Save Budget'}
			</button>
		</div>
	</section>
</div>
