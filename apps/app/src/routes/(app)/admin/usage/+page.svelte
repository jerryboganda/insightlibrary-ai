<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { fade, fly } from 'svelte/transition';
	import { CreditCard, Activity, BarChart3, HardDrive, Filter, Download } from '@lucide/svelte';
	import { api } from '$lib/api';
	import { Skeleton, DonutChart, BarChart } from '$lib/components/ui';

	// Live FinOps feed. Shape matches UsageMetrics (monthlyBudget, currentSpend, queries,
	// costPerQuery, activeUsers, storageGB, events[]).
	const usage = createQuery({ queryKey: ['usage'], queryFn: () => api.getUsage() });

	const data = $derived($usage.data);
	const percentage = $derived(
		data ? (data.currentSpend / data.monthlyBudget) * 100 : 0
	);

	// Top-line stat cards derived from the live feed.
	const stats = $derived.by(() => {
		if (!data) return [];
		return [
			{
				label: 'Total Queries',
				value: data.queries.toLocaleString(),
				sub: `~$${data.costPerQuery} per query`,
				subAccent: 'text-emerald-400',
				icon: Activity
			},
			{
				label: 'Active Users',
				value: String(data.activeUsers),
				sub: 'Across all workspaces',
				icon: BarChart3
			},
			{
				label: 'Vector Storage',
				value: `${data.storageGB} GB`,
				sub: 'Included in base plan',
				icon: HardDrive
			}
		];
	});

	// Sorted event breakdown for the bar chart + table (highest cost first).
	const events = $derived(
		[...(data?.events ?? [])].sort((a, b) => b.cost - a.cost)
	);

	const usd = (n: number) => `$${n.toFixed(2)}`;

	// Client-side period filter for the header toggle.
	let period = $state<'month' | 'all'>('month');

	// Build a CSV from an array of rows and trigger a browser download.
	function downloadCsv(name: string, rows: (string | number)[][]) {
		const csv = rows
			.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
			.join('\n');
		const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = name;
		a.click();
		URL.revokeObjectURL(url);
	}

	// Export the current event breakdown (name, count, cost) as a CSV.
	function exportCsv() {
		const rows: (string | number)[][] = [
			['name', 'count', 'cost'],
			...events.map((e) => [e.name, e.count, e.cost])
		];
		downloadCsv(`usage-${period}.csv`, rows);
	}
</script>

<main class="w-full overflow-y-auto">
	<div class="mx-auto max-w-6xl space-y-8">
		<header class="flex flex-col justify-between gap-4 md:flex-row md:items-center">
			<div>
				<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
					<CreditCard class="h-6 w-6 text-indigo-400" />
					Usage &amp; FinOps
				</h1>
				<p class="mt-1 text-sm text-zinc-400">
					Monitor Copilot SDK consumption and API costs for the current billing cycle.
				</p>
			</div>
			<div class="flex gap-3">
				<button
					onclick={() => (period = period === 'month' ? 'all' : 'month')}
					aria-pressed={period === 'month'}
					class="flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors {period ===
					'month'
						? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
						: 'border-zinc-800 bg-zinc-900/50 text-zinc-300 hover:bg-zinc-800'}"
				>
					<Filter class="h-4 w-4" /> {period === 'month' ? 'This Month' : 'All Time'}
				</button>
				<button
					onclick={exportCsv}
					class="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition-colors hover:bg-indigo-500"
				>
					<Download class="h-4 w-4" /> Export CSV
				</button>
			</div>
		</header>

		<!-- Top stats -->
		<div class="grid grid-cols-1 gap-4 md:grid-cols-4">
			{#if $usage.isLoading}
				{#each Array(4) as _, i (i)}
					<Skeleton class="h-[132px] rounded-xl" />
				{/each}
			{:else if $usage.isError}
				<div
					class="col-span-full rounded-xl border border-rose-900/50 bg-rose-950/20 p-6 text-center"
				>
					<p class="text-sm text-rose-300">Failed to load usage metrics. Please try again.</p>
				</div>
			{:else}
				<!-- Current spend card: gradient top rule + inline budget bar -->
				<div
					in:fly={{ y: 8, duration: 250 }}
					class="glass-panel relative overflow-hidden rounded-xl border border-zinc-800 p-5"
				>
					<div
						class="absolute top-0 left-0 h-1 w-full bg-gradient-to-r from-emerald-500 to-indigo-500"
					></div>
					<div class="mb-4 flex items-center justify-between">
						<h3 class="text-sm font-medium text-zinc-400">Current Spend</h3>
						<CreditCard class="h-4 w-4 text-zinc-500" />
					</div>
					<div class="flex items-end gap-2">
						<span class="text-3xl font-bold text-zinc-100">${data?.currentSpend.toFixed(2)}</span>
						<span class="mb-1 text-sm text-zinc-500">/ ${data?.monthlyBudget}</span>
					</div>
					<div class="mt-4 flex items-center justify-between text-xs text-zinc-500">
						<span>{percentage.toFixed(1)}% of budget</span>
						<div class="h-1.5 w-16 overflow-hidden rounded-full bg-zinc-900">
							<div class="h-full bg-emerald-500" style="width: {Math.min(100, percentage)}%"></div>
						</div>
					</div>
				</div>

				{#each stats as s, i (s.label)}
					<div
						in:fly={{ y: 8, duration: 250, delay: (i + 1) * 40 }}
						class="glass-panel rounded-xl border border-zinc-800 p-5"
					>
						<div class="mb-4 flex items-center justify-between">
							<h3 class="text-sm font-medium text-zinc-400">{s.label}</h3>
							<s.icon class="h-4 w-4 text-zinc-500" />
						</div>
						<div class="text-3xl font-bold text-zinc-100">{s.value}</div>
						<div class="mt-4 text-xs text-zinc-500">
							{#if s.subAccent}<span class={s.subAccent}>{s.sub.split(' ')[0]}</span
								>{s.sub.slice(s.sub.indexOf(' '))}{:else}{s.sub}{/if}
						</div>
					</div>
				{/each}
			{/if}
		</div>

		<!-- Budget donut + event cost bar chart -->
		{#if !$usage.isLoading && !$usage.isError && data}
			<div class="grid grid-cols-1 gap-6 lg:grid-cols-3" in:fade={{ duration: 200 }}>
				<div class="glass-panel rounded-xl border border-zinc-800 p-6">
					<h2 class="mb-2 text-base font-semibold text-zinc-200">Budget Consumed</h2>
					<p class="mb-4 text-xs text-zinc-500">Spend against the monthly budget ceiling.</p>
					<DonutChart
						value={data.currentSpend}
						max={data.monthlyBudget}
						label="of ${data.monthlyBudget} budget"
						centerText={`${percentage.toFixed(0)}%`}
						color={percentage > 90 ? '#f43f5e' : percentage > 70 ? '#f59e0b' : '#10b981'}
					/>
				</div>
				<div class="glass-panel rounded-xl border border-zinc-800 p-6 lg:col-span-2">
					<div class="mb-4 flex items-center justify-between">
						<h2 class="text-base font-semibold text-zinc-200">Cost by AI Event Type</h2>
						<span class="font-mono text-xs text-zinc-500">
							{usd(events.reduce((t, e) => t + e.cost, 0))} total
						</span>
					</div>
					{#if events.length === 0}
						<div class="py-8 text-center text-sm text-zinc-500">No event activity this cycle.</div>
					{:else}
						<BarChart
							bars={events.map((e) => ({ label: e.name, value: e.cost, sub: usd(e.cost) }))}
							format={usd}
						/>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Event breakdown table -->
		<div class="glass-panel overflow-hidden rounded-xl border-zinc-800">
			<div
				class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-6 py-4"
			>
				<h2 class="text-base font-semibold text-zinc-200">Cost Breakdown by AI Event Type</h2>
				{#if !$usage.isLoading && !$usage.isError}
					<span class="font-mono text-xs text-zinc-500">{events.length} operations</span>
				{/if}
			</div>

			{#if $usage.isLoading}
				<div class="space-y-3 p-6">
					{#each Array(4) as _, i (i)}
						<Skeleton class="h-10 rounded-md" />
					{/each}
				</div>
			{:else if $usage.isError}
				<div class="px-6 py-12 text-center text-sm text-rose-300">Failed to load event breakdown.</div>
			{:else if events.length === 0}
				<div class="px-6 py-12 text-center text-sm text-zinc-500">
					No AI events recorded this cycle.
				</div>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full text-left text-sm">
						<thead
							class="border-b border-zinc-800/50 bg-zinc-950/80 text-xs font-medium tracking-wider text-zinc-500 uppercase"
						>
							<tr>
								<th class="px-6 py-4">Event Operation</th>
								<th class="px-6 py-4 text-right">Event Count</th>
								<th class="px-6 py-4 text-right">Estimated Cost</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-zinc-800/50 text-zinc-300">
							{#each events as evt, i (evt.name)}
								<tr in:fade={{ delay: i * 30 }} class="transition-colors hover:bg-zinc-900/40">
									<td class="px-6 py-4 font-medium text-zinc-200">{evt.name}</td>
									<td class="px-6 py-4 text-right font-mono text-zinc-400">
										{evt.count.toLocaleString()}
									</td>
									<td class="px-6 py-4 text-right font-mono text-zinc-200">{usd(evt.cost)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	</div>
</main>
