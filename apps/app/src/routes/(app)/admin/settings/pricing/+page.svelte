<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { DollarSign, Plus, Trash2, Info } from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import type { SystemSettingsResponse } from '@insightlibrary/api-client';

	// A single per-model token-price row. Amounts are USD per 1,000,000 tokens.
	interface PriceRow {
		provider: string;
		model: string;
		inUsdPerM: number;
		outUsdPerM: number;
	}

	const settings = createQuery<SystemSettingsResponse>({
		queryKey: ['system-settings'],
		queryFn: () => api.getSystemSettings()
	});
	const queryClient = useQueryClient();

	/** Coerce an untyped stored model entry into a well-formed editable row. */
	function coerceRow(raw: unknown): PriceRow {
		const r = (raw ?? {}) as Record<string, unknown>;
		return {
			provider: typeof r.provider === 'string' ? r.provider : '',
			model: typeof r.model === 'string' ? r.model : '',
			inUsdPerM: Number(r.inUsdPerM) || 0,
			outUsdPerM: Number(r.outUsdPerM) || 0
		};
	}

	// Editable pricing table, seeded once from the persisted system settings.
	let rows = $state<PriceRow[]>([]);
	let providerFallback = $state<Record<string, unknown>>({});
	let seeded = $state(false);
	$effect(() => {
		const p = $settings.data?.settings?.pricing;
		if (!p || seeded) return;
		rows = (p.models ?? []).map(coerceRow);
		providerFallback = { ...(p.providerFallback ?? {}) };
		seeded = true;
	});

	function addRow(): void {
		rows = [...rows, { provider: '', model: '', inUsdPerM: 0, outUsdPerM: 0 }];
	}
	function deleteRow(i: number): void {
		rows = rows.filter((_, idx) => idx !== i);
	}

	let savedNotice = $state('');
	let savedTimer: ReturnType<typeof setTimeout> | undefined;
	const savePricing = createMutation({
		mutationFn: () =>
			api.updateSystemSettings({
				pricing: {
					models: rows.map((r) => ({
						provider: r.provider.trim(),
						model: r.model.trim(),
						inUsdPerM: Math.max(0, Number(r.inUsdPerM) || 0),
						outUsdPerM: Math.max(0, Number(r.outUsdPerM) || 0)
					})),
					providerFallback
				}
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['system-settings'] });
			savedNotice = 'Pricing saved';
			clearTimeout(savedTimer);
			savedTimer = setTimeout(() => (savedNotice = ''), 3000);
		}
	});
</script>

<div class="max-w-5xl space-y-8 p-6 md:p-8">
	<header>
		<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
			<DollarSign class="h-6 w-6 text-indigo-400" />
			Model Pricing
		</h1>
		<p class="mt-2 text-sm text-zinc-400">
			Per-model token prices used to estimate and meter AI spend across the platform.
		</p>
	</header>

	<!-- Fallback / units notice -->
	<div
		class="flex items-start gap-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-4 text-sm text-indigo-200"
	>
		<Info class="mt-0.5 h-4 w-4 shrink-0 text-indigo-400" />
		<div class="space-y-1">
			<p>
				Amounts are in <span class="font-semibold">USD per 1,000,000 tokens</span> (input and output
				priced separately).
			</p>
			<p class="text-indigo-300/80">
				Leave the table <span class="font-semibold">empty</span> to fall back to the built-in code
				price table — an empty override means the platform's default prices are used.
			</p>
		</div>
	</div>

	<!-- Pricing editor -->
	<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
		<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/30 px-6 py-4">
			<div>
				<h2 class="text-lg font-semibold text-zinc-100">Per-Model Prices</h2>
				<p class="mt-1 text-sm text-zinc-400">
					Override the default price for any provider/model pair.
				</p>
			</div>
			<button
				onclick={addRow}
				disabled={$settings.isLoading}
				class="flex items-center gap-1.5 rounded-md border border-indigo-500/50 bg-zinc-950 px-3 py-1.5 text-sm font-medium text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-40"
			>
				<Plus class="h-4 w-4" /> Add Row
			</button>
		</div>

		{#if $settings.isLoading}
			<div class="space-y-3 p-6">
				{#each Array(3) as _, i (i)}
					<Skeleton class="h-10 rounded-md" />
				{/each}
			</div>
		{:else if rows.length === 0}
			<div class="px-6 py-12 text-center" in:fade={{ duration: 200 }}>
				<p class="text-sm text-zinc-400">No price overrides configured.</p>
				<p class="mt-1 text-xs text-zinc-500">
					Using the built-in default price table. Add a row to override a specific model.
				</p>
			</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-left text-sm">
					<thead
						class="border-b border-zinc-800/50 bg-zinc-950/80 text-xs font-medium tracking-wider text-zinc-500 uppercase"
					>
						<tr>
							<th class="px-6 py-3">Provider</th>
							<th class="px-6 py-3">Model</th>
							<th class="px-6 py-3 text-right">In $/M</th>
							<th class="px-6 py-3 text-right">Out $/M</th>
							<th class="px-6 py-3 text-right">Remove</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-zinc-800/50 text-zinc-300">
						{#each rows as row, i (i)}
							<tr class="transition-colors hover:bg-zinc-900/40">
								<td class="px-6 py-3">
									<input
										type="text"
										placeholder="anthropic"
										bind:value={rows[i].provider}
										class="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
									/>
								</td>
								<td class="px-6 py-3">
									<input
										type="text"
										placeholder="claude-3-5-sonnet"
										bind:value={rows[i].model}
										class="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
									/>
								</td>
								<td class="px-6 py-3 text-right">
									<input
										type="number"
										min="0"
										step="any"
										bind:value={rows[i].inUsdPerM}
										class="w-28 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-right text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
									/>
								</td>
								<td class="px-6 py-3 text-right">
									<input
										type="number"
										min="0"
										step="any"
										bind:value={rows[i].outUsdPerM}
										class="w-28 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-right text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
									/>
								</td>
								<td class="px-6 py-3 text-right">
									<button
										onclick={() => deleteRow(i)}
										aria-label="Delete row"
										class="rounded-md border border-zinc-700 bg-zinc-950 p-2 text-zinc-500 hover:border-rose-500/40 hover:text-rose-400"
									>
										<Trash2 class="h-4 w-4" />
									</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		<div class="flex items-center justify-end gap-3 border-t border-zinc-800 bg-zinc-900/30 p-4">
			{#if savedNotice}
				<span in:fade={{ duration: 150 }} class="text-sm font-medium text-emerald-400"
					>{savedNotice}</span
				>
			{/if}
			{#if $savePricing.isError}
				<span class="text-xs text-rose-400">
					{$savePricing.error instanceof Error ? $savePricing.error.message : 'Save failed'}
				</span>
			{/if}
			<button
				onclick={() => $savePricing.mutate()}
				disabled={$savePricing.isPending || $settings.isLoading}
				class="rounded-md border border-indigo-500/50 bg-zinc-950 px-4 py-2 text-sm font-medium text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-40"
			>
				{$savePricing.isPending ? 'Saving…' : 'Save Pricing'}
			</button>
		</div>
	</section>
</div>
