<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { Activity, Beaker, CheckCircle2, AlertTriangle, XCircle } from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton, Progress } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import type { EvaluationMetrics } from '@insightlibrary/schemas';

	const evaluation = createQuery({ queryKey: ['evaluation'], queryFn: () => api.getEvaluation() });

	const queryClient = useQueryClient();
	const runEval = createMutation({
		mutationFn: () => api.runEvaluation(),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['evaluation'] })
	});

	// Metric cards derived from the live evaluation feed. `good` marks a healthy direction;
	// hallucination is inverted (lower is better).
	const metrics = $derived.by(() => {
		const d = $evaluation.data;
		if (!d) return [];
		return [
			{
				title: 'Faithfulness',
				value: `${d.faithfulness}%`,
				pct: d.faithfulness,
				trend: '+0.2%',
				good: true,
				bar: 'bg-emerald-500',
				help: 'Percentage of claims directly supported by retrieved context.'
			},
			{
				title: 'Citation Accuracy',
				value: `${d.citationAccuracy}%`,
				pct: d.citationAccuracy,
				trend: '+1.5%',
				good: true,
				bar: 'bg-emerald-500',
				help: 'Percentage of citations precisely mapped to the correct source span.'
			},
			{
				title: 'Hallucination Rate',
				value: `${d.hallucinationRate}%`,
				pct: d.hallucinationRate,
				trend: '-0.5%',
				good: true,
				bar: 'bg-rose-500',
				help: 'Percentage of claims fabricated or unsupported by any library source.'
			},
			{
				title: 'Novelty Precision (Delta)',
				value: `${d.noveltyPrecision}%`,
				pct: d.noveltyPrecision,
				trend: '-2.1%',
				good: false,
				bar: 'bg-amber-500',
				help: 'Accuracy of detecting truly new claims vs paraphrased duplicates.'
			}
		];
	});

	const tests = $derived($evaluation.data?.recentTests ?? []);

	function statusMeta(status: EvaluationMetrics['recentTests'][number]['status']) {
		if (status === 'Pass') return { icon: CheckCircle2, class: 'text-emerald-400', label: 'Pass' };
		if (status === 'Fail') return { icon: XCircle, class: 'text-rose-400', label: 'Fail' };
		return { icon: AlertTriangle, class: 'text-amber-400', label: 'Warning' };
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
							<span
								class={cn('text-xs font-semibold', m.good ? 'text-emerald-400' : 'text-rose-400')}
							>
								{m.trend}
							</span>
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
