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
		Loader2,
		HeartPulse,
		AlertTriangle,
		CheckCircle2
	} from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import { cn } from '$lib/utils';

	// Live platform data — every card below is fed by a real endpoint.
	const usage = createQuery({ queryKey: ['usage'], queryFn: () => api.getUsage() });
	const evaluation = createQuery({ queryKey: ['evaluation'], queryFn: () => api.getEvaluation() });
	const review = createQuery({ queryKey: ['review'], queryFn: () => api.listReview() });
	// Real pipeline rollups (jobs, docs, chunks, success rate, stage timings).
	const stats = createQuery({
		queryKey: ['processing-stats'],
		queryFn: () => api.getProcessingStats(),
		refetchInterval: 30_000
	});
	// System health: service version + which data source is actually serving.
	const health = createQuery({
		queryKey: ['health'],
		queryFn: () => api.health(),
		refetchInterval: 60_000,
		retry: 1
	});

	// Any of the KPI feeds still resolving.
	const loading = $derived(
		$usage.isLoading || $evaluation.isLoading || $stats.isLoading || $review.isLoading
	);

	const activeJobs = $derived(
		($stats.data?.jobs.active ?? 0) + ($stats.data?.jobs.queued ?? 0)
	);
	const pendingReview = $derived(($review.data ?? []).filter((i) => i.status === 'pending').length);

	function fmt(n: number | null | undefined): string {
		if (n === undefined || n === null) return '—';
		return n.toLocaleString('en-US');
	}

	// Format a millisecond duration compactly (820ms / 4.2s / 1.8m).
	function fmtMs(ms: number | null | undefined): string {
		if (ms === null || ms === undefined) return '—';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${(ms / 60_000).toFixed(1)}m`;
	}

	// KPI cards — all values from live endpoints.
	const stats_cards = $derived([
		{
			label: 'Active Users',
			value: fmt($usage.data?.activeUsers),
			icon: Users,
			change: `${fmt($usage.data?.queries)} queries`,
			good: true
		},
		{
			label: 'Documents Indexed',
			value: $stats.data ? fmt($stats.data.documents.byStatus?.['indexed'] ?? 0) : '—',
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

	// Pipeline stages in refinery execution order — rows show the live count of
	// jobs currently at each stage plus the measured average stage duration
	// (persisted per-stage timestamps; null before any timed job has run).
	const PIPELINE_STAGES: { stage: string; label: string }[] = [
		{ stage: 'extract', label: 'Extract & Download' },
		{ stage: 'parse', label: 'Structure Parsing' },
		{ stage: 'chunk', label: 'Chunking & Formatting' },
		{ stage: 'contextualize', label: 'Contextual Prefixing' },
		{ stage: 'embed', label: 'Vector Embedding' },
		{ stage: 'index', label: 'Graph & Vector Indexing' },
		{ stage: 'claims', label: 'Claim Extraction' },
		{ stage: 'correlate', label: 'Dedup · Conflict · Graph' }
	];

	const pipelineRows = $derived(
		PIPELINE_STAGES.map(({ stage, label }) => ({
			stage,
			label,
			inFlight: $stats.data?.jobs.byStage?.[stage] ?? 0,
			avgMs: $stats.data?.avgStageDurationsMs?.[stage] ?? null
		}))
	);

	const successRate = $derived(
		$stats.data?.successRate === null || $stats.data?.successRate === undefined
			? null
			: $stats.data.successRate * 100
	);

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
				{#each stats_cards as stat, i (stat.label)}
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
				<!-- Pipeline Health — real rollups from /api/processing/stats -->
				<div class="glass-panel overflow-hidden rounded-xl border-zinc-800">
					<div class="border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
						<h2 class="flex items-center gap-2 text-base font-semibold text-zinc-200">
							<Zap class="h-4 w-4 text-amber-400" />
							Pipeline Health
						</h2>
					</div>
					<div class="p-6">
						{#if $stats.isLoading}
							<div class="space-y-3">
								{#each Array(4) as _, i (i)}
									<Skeleton class="h-6 rounded-md" />
								{/each}
							</div>
						{:else if $stats.isError}
							<p class="text-sm text-rose-300">Failed to load pipeline statistics.</p>
						{:else if $stats.data}
							<!-- Summary chips -->
							<div class="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
								<div class="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
									<div class="text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
										Success Rate
									</div>
									<div
										class={cn(
											'mt-0.5 text-lg font-bold',
											successRate === null
												? 'text-zinc-500'
												: successRate >= 90
													? 'text-emerald-400'
													: 'text-amber-400'
										)}
									>
										{successRate === null ? '—' : `${successRate.toFixed(1)}%`}
									</div>
								</div>
								<div class="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
									<div class="text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
										Avg Job Time
									</div>
									<div class="mt-0.5 text-lg font-bold text-zinc-100">
										{fmtMs($stats.data.avgDurationMs)}
									</div>
								</div>
								<div class="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
									<div class="text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
										Done (24h)
									</div>
									<div class="mt-0.5 text-lg font-bold text-zinc-100">
										{fmt($stats.data.throughput24h.completed)}
									</div>
								</div>
								<div class="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
									<div class="text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
										Failed (24h)
									</div>
									<div
										class={cn(
											'mt-0.5 text-lg font-bold',
											$stats.data.throughput24h.failed > 0 ? 'text-rose-400' : 'text-zinc-100'
										)}
									>
										{fmt($stats.data.throughput24h.failed)}
									</div>
								</div>
							</div>

							<!-- Per-stage rows: live in-flight counts + measured avg durations -->
							<div class="space-y-4">
								{#each pipelineRows as row (row.stage)}
									<div class="flex items-center justify-between">
										<div class="flex items-center gap-3">
											<div
												class={cn(
													'h-2 w-2 rounded-full',
													row.inFlight > 0 ? 'animate-pulse bg-indigo-500' : 'bg-zinc-700'
												)}
											></div>
											<span class="text-sm font-medium text-zinc-300">{row.label}</span>
											{#if row.inFlight > 0}
												<span
													class="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-300"
												>
													{row.inFlight} in flight
												</span>
											{/if}
										</div>
										<span class="font-mono text-xs text-zinc-500">
											{row.avgMs === null ? '—' : `${fmtMs(row.avgMs)} avg`}
										</span>
									</div>
								{/each}
							</div>

							{#if $stats.data.avgStageDurationsMs === null}
								<p class="mt-4 text-xs text-zinc-500">
									Stage timings appear after jobs run with per-stage instrumentation enabled.
								</p>
							{/if}

							{#if activeJobs > 0}
								<div
									in:fade
									class="mt-6 flex items-center gap-2 rounded-lg border border-indigo-500/20 bg-indigo-500/5 px-4 py-3 text-sm text-indigo-300"
								>
									<Loader2 class="h-4 w-4 animate-spin" />
									{activeJobs}
									{activeJobs === 1 ? 'job is' : 'jobs are'} actively processing through the pipeline.
								</div>
							{/if}
						{/if}
					</div>
				</div>
			</div>

			<div class="space-y-6 lg:col-span-1">
				<!-- System Health -->
				<div class="glass-panel overflow-hidden rounded-xl border-zinc-800">
					<div class="border-b border-zinc-800 bg-zinc-900/50 px-5 py-4">
						<h2 class="flex items-center gap-2 text-base font-semibold text-zinc-200">
							<HeartPulse class="h-4 w-4 text-emerald-400" />
							System Health
						</h2>
					</div>
					<div class="space-y-3 p-5">
						{#if $health.isLoading}
							<Skeleton class="h-16 rounded-md" />
						{:else if $health.isError || !$health.data}
							<div
								class="flex items-start gap-2 rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2.5 text-sm text-rose-300"
							>
								<AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
								API health check failed — the server is unreachable or unhealthy.
							</div>
						{:else}
							<div class="flex items-center justify-between text-sm">
								<span class="text-zinc-500">Status</span>
								<span class="flex items-center gap-1.5 font-medium text-emerald-400">
									<CheckCircle2 class="h-3.5 w-3.5" />
									{$health.data.status}
								</span>
							</div>
							<div class="flex items-center justify-between text-sm">
								<span class="text-zinc-500">Service</span>
								<span class="font-mono text-xs text-zinc-300">{$health.data.service}</span>
							</div>
							<div class="flex items-center justify-between text-sm">
								<span class="text-zinc-500">Version</span>
								<span class="font-mono text-xs text-zinc-300">{$health.data.version}</span>
							</div>
							<div class="flex items-center justify-between text-sm">
								<span class="text-zinc-500">Data Source</span>
								<span
									class={cn(
										'rounded border px-2 py-0.5 font-mono text-xs',
										$health.data.dataSource === 'postgres'
											? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
											: 'border-amber-500/30 bg-amber-500/10 text-amber-400'
									)}
								>
									{$health.data.dataSource}
								</span>
							</div>
							{#if $health.data.dataSource === 'memory'}
								<div
									class="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-300"
								>
									<AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
									Running on the in-memory seed repository — data is NOT persisted and will reset on
									restart. Configure DATABASE_URL for production use.
								</div>
							{/if}
						{/if}
					</div>
				</div>

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
