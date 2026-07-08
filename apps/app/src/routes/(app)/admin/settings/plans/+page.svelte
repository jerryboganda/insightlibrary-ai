<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { Layers, Plus } from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import type { AdminPlan } from '@insightlibrary/api-client';

	type PlanUpsert = Parameters<typeof api.upsertAdminPlan>[0];

	const queryClient = useQueryClient();
	const plansQuery = createQuery({
		queryKey: ['admin-plans'],
		queryFn: () => api.listAdminPlans()
	});

	// Per-plan editable draft, seeded lazily from the query. A draft is created once
	// per plan id the first time it appears (covers newly added plans) and is never
	// overwritten on refetch, so in-flight edits survive an invalidation.
	interface PlanDraft {
		name: string;
		seats: number;
		documentCap: number;
		aiBudgetUsd: number;
		stripePriceId: string;
		active: boolean;
	}
	let drafts = $state<Record<string, PlanDraft>>({});
	$effect(() => {
		const items = $plansQuery.data?.items;
		if (!items) return;
		const next = { ...drafts };
		let changed = false;
		for (const p of items) {
			if (!(p.id in next)) {
				next[p.id] = {
					name: p.name,
					seats: p.seats,
					documentCap: p.documentCap,
					aiBudgetUsd: p.aiBudgetUsd,
					stripePriceId: p.stripePriceId ?? '',
					active: p.active
				};
				changed = true;
			}
		}
		if (changed) drafts = next;
	});

	function featureList(features: unknown): string[] {
		if (Array.isArray(features) && features.every((f) => typeof f === 'string')) {
			return features as string[];
		}
		return [];
	}
	const intOrZero = (v: number) => Math.max(0, Math.trunc(Number(v) || 0));
	const numOrZero = (v: number) => Math.max(0, Number(v) || 0);

	// A single save mutation; per-card status is tracked by id so each card shows its
	// own "Saving…" / "Saved" / error state.
	let savingId = $state<string | null>(null);
	let savedId = $state<string | null>(null);
	let errorId = $state<string | null>(null);
	let errorMsg = $state('');
	let savedTimer: ReturnType<typeof setTimeout> | undefined;

	const savePlan = createMutation({
		mutationFn: (payload: PlanUpsert) => api.upsertAdminPlan(payload)
	});

	function save(plan: AdminPlan) {
		const d = drafts[plan.id];
		if (!d) return;
		savingId = plan.id;
		errorId = null;
		errorMsg = '';
		$savePlan.mutate(
			{
				id: plan.id,
				name: d.name.trim() || plan.id,
				seats: intOrZero(d.seats),
				documentCap: intOrZero(d.documentCap),
				aiBudgetUsd: numOrZero(d.aiBudgetUsd),
				stripePriceId: d.stripePriceId.trim() ? d.stripePriceId.trim() : undefined,
				// features are display-only here — pass them through untouched.
				features: plan.features,
				active: d.active
			},
			{
				onSuccess: () => {
					queryClient.invalidateQueries({ queryKey: ['admin-plans'] });
					savedId = plan.id;
					clearTimeout(savedTimer);
					savedTimer = setTimeout(() => (savedId = null), 3000);
				},
				onError: (e) => {
					errorId = plan.id;
					errorMsg = e instanceof Error ? e.message : 'Save failed';
				},
				onSettled: () => {
					savingId = null;
				}
			}
		);
	}

	// Add-plan form.
	let newId = $state('');
	let newName = $state('');
	let newSeats = $state(0);
	let newDocumentCap = $state(0);
	let newAiBudgetUsd = $state(0);
	let addError = $state('');
	let addSaved = $state(false);
	let addTimer: ReturnType<typeof setTimeout> | undefined;

	const addPlan = createMutation({
		mutationFn: (payload: PlanUpsert) => api.upsertAdminPlan(payload)
	});

	function submitNew() {
		const id = newId.trim().toLowerCase();
		if (!id) {
			addError = 'A plan id is required.';
			return;
		}
		addError = '';
		$addPlan.mutate(
			{
				id,
				name: newName.trim() || id,
				seats: intOrZero(newSeats),
				documentCap: intOrZero(newDocumentCap),
				aiBudgetUsd: numOrZero(newAiBudgetUsd)
			},
			{
				onSuccess: () => {
					queryClient.invalidateQueries({ queryKey: ['admin-plans'] });
					newId = '';
					newName = '';
					newSeats = 0;
					newDocumentCap = 0;
					newAiBudgetUsd = 0;
					addSaved = true;
					clearTimeout(addTimer);
					addTimer = setTimeout(() => (addSaved = false), 3000);
				},
				onError: (e) => {
					addError = e instanceof Error ? e.message : 'Could not create plan';
				}
			}
		);
	}

	const inputCls =
		'rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none';
</script>

<div class="max-w-5xl space-y-8 p-6 md:p-8">
	<header>
		<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
			<Layers class="h-6 w-6 text-indigo-400" />
			Plans &amp; Quotas
		</h1>
		<p class="mt-2 text-sm text-zinc-400">
			Define the plan catalog and the seat, document and AI-budget quotas each tier grants. A value
			of <span class="font-medium text-zinc-300">0 means unlimited</span>.
		</p>
	</header>

	<!-- Add plan -->
	<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
		<div class="border-b border-zinc-800 bg-zinc-900/30 px-6 py-4">
			<h2 class="text-lg font-semibold text-zinc-100">Add a plan</h2>
			<p class="mt-1 text-sm text-zinc-400">
				The id is a permanent lowercase slug (e.g. <code class="text-zinc-300">team</code>). Quotas
				can be edited below after creation.
			</p>
		</div>
		<div class="grid grid-cols-1 gap-4 p-6 sm:grid-cols-2 lg:grid-cols-3">
			<label class="flex flex-col gap-1.5">
				<span class="text-xs font-medium text-zinc-400">Plan id (slug)</span>
				<input
					type="text"
					placeholder="team"
					bind:value={newId}
					oninput={() => (newId = newId.toLowerCase())}
					class={inputCls}
				/>
			</label>
			<label class="flex flex-col gap-1.5">
				<span class="text-xs font-medium text-zinc-400">Display name</span>
				<input type="text" placeholder="Team" bind:value={newName} class={inputCls} />
			</label>
			<label class="flex flex-col gap-1.5">
				<span class="text-xs font-medium text-zinc-400">Seats <span class="text-zinc-600">(0 = ∞)</span></span>
				<input type="number" min="0" step="1" bind:value={newSeats} class={inputCls} />
			</label>
			<label class="flex flex-col gap-1.5">
				<span class="text-xs font-medium text-zinc-400">Document cap <span class="text-zinc-600">(0 = ∞)</span></span>
				<input type="number" min="0" step="1" bind:value={newDocumentCap} class={inputCls} />
			</label>
			<label class="flex flex-col gap-1.5">
				<span class="text-xs font-medium text-zinc-400">AI budget (USD) <span class="text-zinc-600">(0 = ∞)</span></span>
				<input type="number" min="0" step="0.01" bind:value={newAiBudgetUsd} class={inputCls} />
			</label>
		</div>
		<div class="flex items-center justify-end gap-3 border-t border-zinc-800 bg-zinc-900/30 p-4">
			{#if addSaved}
				<span in:fade={{ duration: 150 }} class="text-sm font-medium text-emerald-400">Plan created</span>
			{/if}
			{#if addError}
				<span class="text-xs text-rose-400">{addError}</span>
			{/if}
			<button
				onclick={() => submitNew()}
				disabled={$addPlan.isPending || !newId.trim()}
				class="flex items-center gap-2 rounded-md border border-indigo-500/50 bg-zinc-950 px-4 py-2 text-sm font-medium text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-40"
			>
				<Plus class="h-4 w-4" />
				{$addPlan.isPending ? 'Adding…' : 'Add plan'}
			</button>
		</div>
	</section>

	<!-- Plan catalog -->
	{#if $plansQuery.isLoading}
		<div class="space-y-4">
			{#each Array(3) as _, i (i)}
				<Skeleton class="h-64 rounded-xl" />
			{/each}
		</div>
	{:else if $plansQuery.isError}
		<div class="glass-panel rounded-xl border border-rose-500/30 p-6 text-sm text-rose-400">
			{$plansQuery.error instanceof Error ? $plansQuery.error.message : 'Failed to load plans.'}
		</div>
	{:else if ($plansQuery.data?.items.length ?? 0) === 0}
		<div class="glass-panel rounded-xl border border-zinc-800 px-6 py-10 text-center text-sm text-zinc-500">
			No plans defined yet. Add one above to start your catalog.
		</div>
	{:else}
		<div class="space-y-4">
			{#each $plansQuery.data?.items ?? [] as plan (plan.id)}
				{#if drafts[plan.id]}
					{@const d = drafts[plan.id]}
					{@const features = featureList(plan.features)}
					<section
						in:fly={{ y: 8, duration: 220 }}
						class="glass-panel overflow-hidden rounded-xl border border-zinc-800"
					>
						<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/30 px-6 py-4">
							<div class="flex items-center gap-3">
								<h3 class="text-base font-semibold text-zinc-100">{d.name || plan.id}</h3>
								<code class="rounded bg-zinc-800/70 px-1.5 py-0.5 font-mono text-xs text-zinc-400">{plan.id}</code>
							</div>
							<label class="flex cursor-pointer items-center gap-2">
								<span class="text-xs font-medium {d.active ? 'text-emerald-400' : 'text-zinc-500'}">
									{d.active ? 'Active' : 'Inactive'}
								</span>
								<button
									type="button"
									role="switch"
									aria-label="Toggle plan active"
									aria-checked={d.active}
									onclick={() => (d.active = !d.active)}
									class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors {d.active
										? 'bg-indigo-500/70'
										: 'bg-zinc-700'}"
								>
									<span
										class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform {d.active
											? 'translate-x-6'
											: 'translate-x-1'}"
									></span>
								</button>
							</label>
						</div>

						<div class="grid grid-cols-1 gap-4 p-6 sm:grid-cols-2 lg:grid-cols-3">
							<label class="flex flex-col gap-1.5">
								<span class="text-xs font-medium text-zinc-400">Display name</span>
								<input type="text" bind:value={d.name} class={inputCls} />
							</label>
							<label class="flex flex-col gap-1.5">
								<span class="text-xs font-medium text-zinc-400">Seats <span class="text-zinc-600">(0 = ∞)</span></span>
								<input type="number" min="0" step="1" bind:value={d.seats} class={inputCls} />
							</label>
							<label class="flex flex-col gap-1.5">
								<span class="text-xs font-medium text-zinc-400">Document cap <span class="text-zinc-600">(0 = ∞)</span></span>
								<input type="number" min="0" step="1" bind:value={d.documentCap} class={inputCls} />
							</label>
							<label class="flex flex-col gap-1.5">
								<span class="text-xs font-medium text-zinc-400">AI budget (USD) <span class="text-zinc-600">(0 = ∞)</span></span>
								<input type="number" min="0" step="0.01" bind:value={d.aiBudgetUsd} class={inputCls} />
							</label>
							<label class="flex flex-col gap-1.5 sm:col-span-2">
								<span class="text-xs font-medium text-zinc-400">Stripe price id <span class="text-zinc-600">(optional)</span></span>
								<input type="text" placeholder="price_…" bind:value={d.stripePriceId} class={inputCls} />
							</label>
						</div>

						<div class="border-t border-zinc-800/60 px-6 pb-6">
							<span class="text-xs font-medium text-zinc-400">Features</span>
							{#if features.length > 0}
								<p class="mt-1.5 text-sm text-zinc-300">{features.join(', ')}</p>
							{:else}
								<p class="mt-1.5 text-sm text-zinc-600">No named features (managed elsewhere).</p>
							{/if}
						</div>

						<div class="flex items-center justify-end gap-3 border-t border-zinc-800 bg-zinc-900/30 p-4">
							{#if savedId === plan.id}
								<span in:fade={{ duration: 150 }} class="text-sm font-medium text-emerald-400">Saved</span>
							{/if}
							{#if errorId === plan.id}
								<span class="text-xs text-rose-400">{errorMsg}</span>
							{/if}
							<button
								onclick={() => save(plan)}
								disabled={savingId === plan.id}
								class="rounded-md border border-indigo-500/50 bg-zinc-950 px-4 py-2 text-sm font-medium text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-40"
							>
								{savingId === plan.id ? 'Saving…' : 'Save plan'}
							</button>
						</div>
					</section>
				{/if}
			{/each}
		</div>
	{/if}
</div>
