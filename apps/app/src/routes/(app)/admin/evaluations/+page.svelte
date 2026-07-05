<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { Activity, Beaker, CheckCircle2, AlertTriangle, XCircle, Plus, Trash2, ListChecks, Pencil, Check, X } from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton, Progress } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import type { EvaluationMetrics } from '@insightlibrary/schemas';

	// One persisted run in the trend history (percentage-scaled), mirroring the
	// server's EvalRunSummary. `getEvaluation()` now returns `history` newest-first.
	interface EvalRunSummary {
		id: string;
		faithfulness: number;
		citationAccuracy: number;
		hallucinationRate: number;
		noveltyPrecision: number;
		createdAt: string;
	}
	type EvaluationPayload = EvaluationMetrics & { history?: EvalRunSummary[] };

	interface GoldenRecord {
		id: string;
		query: string;
		expect: string;
		source: 'seed' | 'custom';
		createdAt: string;
		updatedAt: string;
	}

	const queryClient = useQueryClient();

	const evaluation = createQuery({
		queryKey: ['evaluation'],
		queryFn: () => api.getEvaluation() as Promise<EvaluationPayload>
	});

	const runEval = createMutation({
		mutationFn: () => api.runEvaluation(),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['evaluation'] })
	});

	// Real trend deltas: latest run vs the one before it (from eval_runs history).
	// No prior run → no delta chip (honest: nothing to compare against).
	const prevRun = $derived.by(() => {
		const h = $evaluation.data?.history ?? [];
		// history[0] is the latest (== current metrics); [1] is the previous run.
		return h.length >= 2 ? h[1] : null;
	});

	function fmtDelta(current: number, previous: number | undefined): string | null {
		if (previous === undefined) return null;
		const d = Math.round((current - previous) * 10) / 10;
		return `${d >= 0 ? '+' : ''}${d}%`;
	}

	// Metric cards derived from the live evaluation feed. `good` marks a healthy
	// direction; hallucination is inverted (a decrease is good).
	const metrics = $derived.by(() => {
		const d = $evaluation.data;
		if (!d) return [];
		const p = prevRun;
		const card = (
			title: string,
			value: number,
			lowerIsBetter: boolean,
			bar: string,
			help: string,
			prevValue: number | undefined
		) => {
			const trend = fmtDelta(value, prevValue);
			// "good" = the change moved in the desired direction.
			const delta = prevValue === undefined ? 0 : value - prevValue;
			const good = lowerIsBetter ? delta <= 0 : delta >= 0;
			return { title, value: `${value}%`, pct: value, trend, good, bar, help };
		};
		return [
			card('Faithfulness', d.faithfulness, false, 'bg-emerald-500', 'Percentage of claims directly supported by retrieved context.', p?.faithfulness),
			card('Citation Accuracy', d.citationAccuracy, false, 'bg-emerald-500', 'Percentage of citations precisely mapped to the correct source span.', p?.citationAccuracy),
			card('Hallucination Rate', d.hallucinationRate, true, 'bg-rose-500', 'Percentage of claims fabricated or unsupported by any library source.', p?.hallucinationRate),
			card('Novelty Precision (Delta)', d.noveltyPrecision, false, 'bg-amber-500', 'Accuracy of detecting truly new claims vs paraphrased duplicates.', p?.noveltyPrecision)
		];
	});

	const tests = $derived($evaluation.data?.recentTests ?? []);
	const runCount = $derived($evaluation.data?.history?.length ?? 0);

	function statusMeta(status: EvaluationMetrics['recentTests'][number]['status']) {
		if (status === 'Pass') return { icon: CheckCircle2, class: 'text-emerald-400', label: 'Pass' };
		if (status === 'Fail') return { icon: XCircle, class: 'text-rose-400', label: 'Fail' };
		return { icon: AlertTriangle, class: 'text-amber-400', label: 'Warning' };
	}

	// ── Golden set management (C8) ────────────────────────────────────────────
	const golden = createQuery({
		queryKey: ['golden'],
		queryFn: () => api.listGolden() as Promise<GoldenRecord[]>
	});

	let newQuery = $state('');
	let newExpect = $state('');
	let formError = $state<string | null>(null);

	const addGolden = createMutation({
		mutationFn: (input: { query: string; expect: string }) => api.createGolden(input),
		onSuccess: () => {
			newQuery = '';
			newExpect = '';
			formError = null;
			queryClient.invalidateQueries({ queryKey: ['golden'] });
		},
		onError: (e: unknown) => {
			formError = e instanceof Error ? e.message : 'Failed to add item.';
		}
	});

	const removeGolden = createMutation({
		mutationFn: (id: string) => api.deleteGolden(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['golden'] })
	});

	// Inline edit of an existing item.
	let editingId = $state<string | null>(null);
	let editQuery = $state('');
	let editExpect = $state('');

	const editGolden = createMutation({
		mutationFn: (input: { id: string; query: string; expect: string }) =>
			api.updateGolden(input.id, { query: input.query, expect: input.expect }),
		onSuccess: () => {
			editingId = null;
			queryClient.invalidateQueries({ queryKey: ['golden'] });
		}
	});

	function startEdit(item: GoldenRecord) {
		editingId = item.id;
		editQuery = item.query;
		editExpect = item.expect;
	}
	function saveEdit() {
		if (!editingId || !editQuery.trim() || !editExpect.trim()) return;
		$editGolden.mutate({ id: editingId, query: editQuery.trim(), expect: editExpect.trim() });
	}

	function submitGolden(e: SubmitEvent) {
		e.preventDefault();
		if (!newQuery.trim() || !newExpect.trim()) {
			formError = 'Both a query and an expected substring are required.';
			return;
		}
		$addGolden.mutate({ query: newQuery.trim(), expect: newExpect.trim() });
	}
</script>

<main class="w-full overflow-y-auto">
	<div class="mx-auto max-w-6xl space-y-8">
		<header class="flex flex-col justify-between gap-4 md:flex-row md:items-center">
			<div>
				<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
					<Activity class="h-6 w-6 text-indigo-400" />
					RAG Evaluation Dashboard
				</h1>
				<p class="mt-1 text-sm text-zinc-400">
					Monitor answer faithfulness, citation accuracy, and hallucination rates across pipeline
					performance.
				</p>
			</div>
			<button
				onclick={() => $runEval.mutate()}
				disabled={$runEval.isPending}
				class="flex items-center gap-2 rounded-md border border-indigo-500/50 bg-zinc-950 px-4 py-2 text-sm font-medium text-indigo-400 transition-colors hover:bg-indigo-500/10 disabled:opacity-50"
			>
				<Beaker class="h-4 w-4" /> {$runEval.isPending ? 'Running…' : 'Run Manual Eval'}
			</button>
		</header>

		<!-- Metric cards -->
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
			{#if $evaluation.isLoading}
				{#each Array(4) as _, i (i)}
					<Skeleton class="h-[164px] rounded-xl" />
				{/each}
			{:else}
				{#each metrics as m, i (m.title)}
					<div
						in:fly={{ y: 8, duration: 250, delay: i * 40 }}
						class="glass-panel group relative rounded-xl border border-zinc-800 p-5"
					>
						<h3 class="mb-2 text-sm font-medium text-zinc-400">{m.title}</h3>
						<div class="flex items-baseline gap-3">
							<span class="text-3xl font-bold text-zinc-100">{m.value}</span>
							{#if m.trend}
								<span
									class={cn('text-xs font-semibold', m.good ? 'text-emerald-400' : 'text-rose-400')}
									title="Change vs the previous eval run"
								>
									{m.trend}
								</span>
							{:else}
								<span class="text-xs text-zinc-600" title="Run the eval at least twice to see a trend">
									—
								</span>
							{/if}
						</div>
						<Progress value={m.pct} barClass={m.bar} class="mt-4" />
						<p
							class="mt-4 line-clamp-2 text-xs leading-relaxed text-zinc-500 transition-all group-hover:line-clamp-none"
						>
							{m.help}
						</p>
					</div>
				{/each}
			{/if}
		</div>
		{#if !$evaluation.isLoading}
			<p class="-mt-4 text-xs text-zinc-600">
				{#if runCount >= 2}
					Trends compare the latest run to the previous one ({runCount} run{runCount === 1 ? '' : 's'} recorded).
				{:else if runCount === 1}
					One run recorded — run the eval again to see trend deltas.
				{:else}
					No runs recorded yet — showing baseline metrics. Run a manual eval to start tracking trends.
				{/if}
			</p>
		{/if}

		<!-- Golden set management (C8) -->
		<div class="glass-panel overflow-hidden rounded-xl border-zinc-800">
			<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
				<h2 class="flex items-center gap-2 text-base font-semibold text-zinc-200">
					<ListChecks class="h-4 w-4 text-indigo-400" /> Golden Evaluation Set
				</h2>
				{#if !$golden.isLoading && $golden.data}
					<span class="font-mono text-xs text-zinc-500">{$golden.data.length} items</span>
				{/if}
			</div>

			<div class="border-b border-zinc-800 bg-zinc-950/40 px-6 py-4">
				<form onsubmit={submitGolden} class="flex flex-col gap-3 sm:flex-row sm:items-end">
					<label class="flex-1 text-xs text-zinc-400">
						Test query
						<input
							bind:value={newQuery}
							placeholder="management of adrenal crisis in Addison disease"
							class="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none"
						/>
					</label>
					<label class="flex-1 text-xs text-zinc-400">
						Expected substring
						<input
							bind:value={newExpect}
							placeholder="hydrocortisone"
							class="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none"
						/>
					</label>
					<button
						type="submit"
						disabled={$addGolden.isPending}
						class="flex items-center justify-center gap-1.5 rounded-md border border-indigo-500/50 bg-zinc-950 px-4 py-2 text-sm font-medium text-indigo-400 transition-colors hover:bg-indigo-500/10 disabled:opacity-50"
					>
						<Plus class="h-4 w-4" /> {$addGolden.isPending ? 'Adding…' : 'Add'}
					</button>
				</form>
				{#if formError}
					<p class="mt-2 text-xs text-rose-400">{formError}</p>
				{:else}
					<p class="mt-2 text-xs text-zinc-600">
						A run passes an item when retrieval surfaces the expected substring for the query. Seeded
						items come from the bundled medical set and can be removed.
					</p>
				{/if}
			</div>

			{#if $golden.isLoading}
				<div class="space-y-3 p-6">
					{#each Array(3) as _, i (i)}
						<Skeleton class="h-10 rounded-md" />
					{/each}
				</div>
			{:else if $golden.isError}
				<div class="flex flex-col items-center gap-2 px-6 py-16 text-center">
					<AlertTriangle class="h-8 w-8 text-rose-500/70" />
					<p class="text-sm text-zinc-400">Could not load the golden set.</p>
					<p class="text-xs text-zinc-600">
						{$golden.error instanceof Error ? $golden.error.message : 'Requires an admin session and a database.'}
					</p>
				</div>
			{:else if ($golden.data?.length ?? 0) === 0}
				<div class="flex flex-col items-center gap-2 px-6 py-16 text-center">
					<ListChecks class="h-8 w-8 text-zinc-600" />
					<p class="text-sm text-zinc-400">No golden items yet.</p>
					<p class="text-xs text-zinc-600">Add a query and its expected substring above.</p>
				</div>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full text-left text-sm">
						<thead
							class="border-b border-zinc-800/50 bg-zinc-950/80 text-xs font-medium tracking-wider text-zinc-500 uppercase"
						>
							<tr>
								<th class="px-6 py-4">Query</th>
								<th class="px-6 py-4">Expected</th>
								<th class="px-6 py-4">Source</th>
								<th class="px-6 py-4 text-right">Actions</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-zinc-800/50 text-zinc-300">
							{#each $golden.data ?? [] as item (item.id)}
								<tr in:fade={{ duration: 150 }} class="transition-colors hover:bg-zinc-900/40">
									{#if editingId === item.id}
										<td class="px-6 py-3">
											<input
												bind:value={editQuery}
												class="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
											/>
										</td>
										<td class="px-6 py-3">
											<input
												bind:value={editExpect}
												class="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
											/>
										</td>
										<td class="px-6 py-3">
											<span
												class={cn(
													'rounded px-2 py-0.5 text-[10px] font-medium',
													item.source === 'seed' ? 'bg-zinc-800 text-zinc-400' : 'bg-indigo-500/15 text-indigo-300'
												)}
											>
												{item.source}
											</span>
										</td>
										<td class="px-6 py-3 text-right">
											<div class="inline-flex items-center gap-1">
												<button
													onclick={saveEdit}
													disabled={$editGolden.isPending}
													class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-emerald-400 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
													aria-label="Save changes"
												>
													<Check class="h-3.5 w-3.5" /> Save
												</button>
												<button
													onclick={() => (editingId = null)}
													class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
													aria-label="Cancel edit"
												>
													<X class="h-3.5 w-3.5" /> Cancel
												</button>
											</div>
										</td>
									{:else}
										<td class="px-6 py-3 text-zinc-200">{item.query}</td>
										<td class="px-6 py-3 font-mono text-xs text-zinc-400">{item.expect}</td>
										<td class="px-6 py-3">
											<span
												class={cn(
													'rounded px-2 py-0.5 text-[10px] font-medium',
													item.source === 'seed' ? 'bg-zinc-800 text-zinc-400' : 'bg-indigo-500/15 text-indigo-300'
												)}
											>
												{item.source}
											</span>
										</td>
										<td class="px-6 py-3 text-right">
											<div class="inline-flex items-center gap-1">
												<button
													onclick={() => startEdit(item)}
													class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
													aria-label="Edit golden item"
												>
													<Pencil class="h-3.5 w-3.5" /> Edit
												</button>
												<button
													onclick={() => $removeGolden.mutate(item.id)}
													disabled={$removeGolden.isPending}
													class="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-500 transition-colors hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-50"
													aria-label="Remove golden item"
												>
													<Trash2 class="h-3.5 w-3.5" /> Remove
												</button>
											</div>
										</td>
									{/if}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>

		<!-- Recent synthetic tests -->
		<div class="glass-panel overflow-hidden rounded-xl border-zinc-800">
			<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
				<h2 class="text-base font-semibold text-zinc-200">Recent Synthetic Tests</h2>
				{#if !$evaluation.isLoading}
					<span class="font-mono text-xs text-zinc-500">{tests.length} runs</span>
				{/if}
			</div>

			{#if $evaluation.isLoading}
				<div class="space-y-3 p-6">
					{#each Array(3) as _, i (i)}
						<Skeleton class="h-10 rounded-md" />
					{/each}
				</div>
			{:else if tests.length === 0}
				<div class="flex flex-col items-center gap-2 px-6 py-16 text-center">
					<Beaker class="h-8 w-8 text-zinc-600" />
					<p class="text-sm text-zinc-400">No synthetic tests have run yet.</p>
					<p class="text-xs text-zinc-600">Run a manual eval to populate this table.</p>
				</div>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full text-left text-sm">
						<thead
							class="border-b border-zinc-800/50 bg-zinc-950/80 text-xs font-medium tracking-wider text-zinc-500 uppercase"
						>
							<tr>
								<th class="px-6 py-4">Status</th>
								<th class="px-6 py-4">Test Query</th>
								<th class="px-6 py-4">Search/Retrieval Mode</th>
								<th class="px-6 py-4 text-center">Faithfulness Score</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-zinc-800/50 text-zinc-300">
							{#each tests as test, i (i)}
								{@const meta = statusMeta(test.status)}
								<tr in:fade={{ delay: i * 30 }} class="transition-colors hover:bg-zinc-900/40">
									<td class="px-6 py-4 font-medium">
										<span class={cn('flex items-center gap-1.5', meta.class)}>
											<meta.icon class="h-4 w-4" />
											{meta.label}
										</span>
									</td>
									<td class="px-6 py-4 text-zinc-200">{test.query}</td>
									<td class="px-6 py-4 text-zinc-400">{test.mode}</td>
									<td class="px-6 py-4 text-center font-mono">
										<span
											class={cn(
												'font-semibold',
												test.faithfulness < 0.9 ? 'text-amber-400' : 'text-emerald-400'
											)}
										>
											{test.faithfulness.toFixed(2)}
										</span>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	</div>
</main>
