<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import {
		Activity,
		Server,
		Users,
		FileText,
		Settings,
		ShieldCheck,
		Database,
		Zap,
		ArrowUpRight,
		Loader2
	} from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import { cn } from '$lib/utils';

	// Live platform data — mapped into the KPI cards where a real endpoint exists.
	const usage = createQuery({ queryKey: ['usage'], queryFn: () => api.getUsage() });
	const evaluation = createQuery({ queryKey: ['evaluation'], queryFn: () => api.getEvaluation() });
	const processing = createQuery({ queryKey: ['processing'], queryFn: () => api.listProcessing() });
	const review = createQuery({ queryKey: ['review'], queryFn: () => api.listReview() });

	// Any of the KPI feeds still resolving.
	const loading = $derived(
		$usage.isLoading || $evaluation.isLoading || $processing.isLoading || $review.isLoading
	);

	const activeJobs = $derived(
		($processing.data ?? []).filter((j) => j.stage !== 'done' && j.stage !== 'failed').length
	);
	const pendingReview = $derived(($review.data ?? []).filter((i) => i.status === 'pending').length);

	function fmt(n: number | undefined): string {
		if (n === undefined) return '—';
		return n.toLocaleString('en-US');
	}

	// KPI cards — real numbers where the API maps, illustrative totals elsewhere (prototype spec).
	const stats = $derived([
		{
			label: 'Active Users',
			value: fmt($usage.data?.activeUsers),
			icon: Users,
			change: `${fmt($usage.data?.queries)} queries`,
			good: true
		},
		{
			label: 'Documents Indexed',
			value: fmt($processing.data?.length),
			icon: FileText,
			change: `${activeJobs} in pipeline`,
			good: activeJobs === 0
		},
		{
			label: 'Faithfulness',
			value: $evaluation.data ? `${$evaluation.data.faithfulness}%` : '—',
			icon: ShieldCheck,
			change: `${pendingReview} pending review`,
			good: pendingReview === 0
		},
		{
			label: 'Storage Used',
			value: $usage.data ? `${$usage.data.storageGB} GB` : '—',
			icon: Database,
			change: `$${$usage.data?.currentSpend?.toFixed(0) ?? '0'} spend`,
			good: true
		}
	]);

	// Live pipeline health — illustrative latencies (no metrics endpoint; prototype spec).
	const pipeline = [
		{ label: 'OCR & Document Parsing', latency: '12ms' },
		{ label: 'Semantic & Fast GraphRAG Chunking', latency: '45ms' },
		{ label: 'Topic Canonicalization & Delta Merge', latency: '120ms' },
		{ label: 'Vector Search & ColBERT Reranking', latency: '85ms' }
	];

	const links = [
		{ href: '/admin/processing', icon: Server, label: 'Processing Jobs' },
		{ href: '/admin/evaluations', icon: Activity, label: 'RAG Evaluations' },
		{ href: '/admin/usage', icon: Activity, label: 'Usage & Cost' },
		{ href: '/admin/users', icon: Users, label: 'Tenant Users' },
		{ href: '/admin/audit-logs', icon: ShieldCheck, label: 'Audit Logs' }
	];
</script>

<main class="w-full overflow-y-auto">
	<div class="mx-auto max-w-6xl space-y-8">
		<header class="flex flex-col justify-between gap-4 md:flex-row md:items-center">
			<div>
				<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
					<Activity class="h-6 w-6 text-indigo-400" />
					Platform Operations
				</h1>
				<p class="mt-1 text-sm text-zinc-400">
					Global oversight of multi-tenant instances, data pipelines, and infrastructure health.
				</p>
			</div>
			<div class="flex items-center gap-3">
				<a
					href="/admin/settings"
					class="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
				>
					<Settings class="h-4 w-4" /> Global Settings
				</a>
			</div>
		</header>

		<!-- KPI cards -->
		<div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
			{#if loading}
				{#each Array(4) as _, i (i)}
					<Skeleton class="h-[132px] rounded-xl" />
				{/each}
			{:else}
				{#each stats as stat, i (stat.label)}
					<div
						in:fly={{ y: 8, duration: 250, delay: i * 40 }}
						class="glass-panel rounded-xl border border-zinc-800 p-5"
					>
						<div class="mb-3 flex items-center justify-between text-zinc-400">
							<stat.icon class="h-5 w-5" />
							<span
								class={cn('text-xs font-medium', stat.good ? 'text-emerald-400' : 'text-amber-400')}
							>
								{stat.change}
							</span>
						</div>
						<div class="mb-1 text-sm font-medium tracking-wider text-zinc-500 uppercase">
							{stat.label}
						</div>
						<div class="text-3xl font-bold text-zinc-100">{stat.value}</div>
					</div>
				{/each}
			{/if}
		</div>

		<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
			<div class="space-y-6 lg:col-span-2">
				<!-- Live Pipeline Health -->
				<div class="glass-panel overflow-hidden rounded-xl border-zinc-800">
					<div class="border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
						<h2 class="flex items-center gap-2 text-base font-semibold text-zinc-200">
							<Zap class="h-4 w-4 text-amber-400" />
							Live Pipeline Health
						</h2>
					</div>
					<div class="p-6">
						<div class="space-y-5">
							{#each pipeline as stage (stage.label)}
								<div class="flex items-center justify-between">
									<div class="flex items-center gap-3">
										<div class="h-2 w-2 animate-pulse rounded-full bg-emerald-500"></div>
										<span class="text-sm font-medium text-zinc-300">{stage.label}</span>
									</div>
									<span class="font-mono text-xs text-zinc-500">{stage.latency} latency</span>
								</div>
							{/each}
						</div>

						{#if !loading && activeJobs > 0}
							<div
								in:fade
								class="mt-6 flex items-center gap-2 rounded-lg border border-indigo-500/20 bg-indigo-500/5 px-4 py-3 text-sm text-indigo-300"
							>
								<Loader2 class="h-4 w-4 animate-spin" />
								{activeJobs}
								{activeJobs === 1 ? 'job is' : 'jobs are'} actively processing through the pipeline.
							</div>
						{/if}
					</div>
				</div>
			</div>

			<div class="space-y-6 lg:col-span-1">
				<!-- Management Links -->
				<div class="glass-panel overflow-hidden rounded-xl border-zinc-800">
					<div class="border-b border-zinc-800 bg-zinc-900/50 px-5 py-4">
						<h2 class="text-base font-semibold text-zinc-200">Management Links</h2>
					</div>
					<div class="p-3">
						{#each links as link (link.href)}
							<a
								href={link.href}
								class="group flex items-center justify-between rounded-lg p-3 transition-colors hover:bg-zinc-900/50"
							>
								<div class="flex items-center gap-3">
									<link.icon class="h-4 w-4 text-zinc-400 group-hover:text-indigo-400" />
									<span class="text-sm text-zinc-300 group-hover:text-zinc-100">{link.label}</span>
								</div>
								<ArrowUpRight
									class="h-4 w-4 text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100"
								/>
							</a>
						{/each}
					</div>
				</div>
			</div>
		</div>
	</div>
</main>
