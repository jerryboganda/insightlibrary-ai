<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { fade, fly } from 'svelte/transition';
	import {
		Server,
		FileSearch,
		Activity,
		ArrowRightCircle,
		RefreshCcw,
		Search,
		X,
		Play,
		Square,
		AlertCircle,
		FileText,
		CheckCircle2,
		Copy
	} from '@lucide/svelte';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import type { ProcessingJob, ProcessingStage } from '@insightlibrary/schemas';

	const qc = useQueryClient();
	const processing = createQuery({
		queryKey: ['processing'],
		queryFn: () => api.listProcessing()
	});
	// Real pipeline rollups (success rate, chunk counts, avg durations, 24h
	// throughput) from GET /api/processing/stats — replaces the fabricated
	// header cards. Timing fields are null until stage timestamps exist.
	const stats = createQuery({
		queryKey: ['processing-stats'],
		queryFn: () => api.getProcessingStats(),
		refetchInterval: 30_000
	});

	// Cancel / retry a job, then refetch the queue so status settles.
	const cancelMutation = createMutation({
		mutationFn: (id: string) => api.cancelJob(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['processing'] })
	});
	const retryMutation = createMutation({
		mutationFn: (id: string) => api.retryJob(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['processing'] })
	});

	// Short-lived confirmation shown near the copy controls.
	let copyNotice = $state('');
	let copyNoticeTimer: ReturnType<typeof setTimeout> | undefined;
	function flashCopyNotice(msg: string) {
		copyNotice = msg;
		clearTimeout(copyNoticeTimer);
		copyNoticeTimer = setTimeout(() => (copyNotice = ''), 1800);
	}
	function copyToClipboard(value: string, msg = 'Copied') {
		navigator.clipboard.writeText(value);
		flashCopyNotice(msg);
	}

	// The live stream may report progress/stage ahead of the last refetch. Overlay those
	// per-job so the table reflects the freshest state without refetching everything.
	let liveOverrides = $state<Record<string, { stage: ProcessingStage; progress: number; message?: string }>>({});

	// Merge the query snapshot with any live SSE overrides.
	const jobs = $derived.by<ProcessingJob[]>(() => {
		const base = $processing.data ?? [];
		return base.map((j) => {
			const o = liveOverrides[j.id];
			return o ? { ...j, ...o } : j;
		});
	});

	// ── Stage → display metadata ────────────────────────────────────────────────
	// The refinery pipeline runs: queued → extract → parse → chunk → contextualize →
	// embed → index → claims → correlate → done (or failed).
	const STAGE_ORDER: ProcessingStage[] = [
		'queued',
		'extract',
		'parse',
		'chunk',
		'contextualize',
		'embed',
		'index',
		'claims',
		'correlate',
		'done'
	];
	const STAGE_LABEL: Record<ProcessingStage, string> = {
		queued: 'Queued',
		extract: 'Extract & Download',
		parse: 'Structure Parsing (pages/blocks)',
		chunk: 'Chunking & Formatting',
		contextualize: 'Contextual Prefixing',
		embed: 'Vector Embedding',
		index: 'Graph & Vector Indexing',
		claims: 'Claim Extraction',
		correlate: 'Dedup · Conflict · Graph',
		graph: 'Graph Building',
		refine: 'Refinement',
		done: 'Completed',
		failed: 'Failed Validation'
	};

	type DisplayStatus = 'processing' | 'completed' | 'failed';
	function statusOf(stage: ProcessingStage): DisplayStatus {
		if (stage === 'done') return 'completed';
		if (stage === 'failed') return 'failed';
		return 'processing';
	}

	// Derive a vertical pipeline-step timeline from the job's real current stage.
	// Per-stage average durations come from measured stage timestamps
	// (/api/processing/stats avgStageDurationsMs); shown as '—' until data exists.
	function stepsFor(stage: ProcessingStage) {
		const stageAvgs = $stats.data?.avgStageDurationsMs ?? null;
		if (stage === 'failed') {
			return [{ name: 'Document Ingestion', status: 'error' as const, avgMs: null }];
		}
		const current = STAGE_ORDER.indexOf(stage);
		return STAGE_ORDER.filter((s) => s !== 'done').map((s) => {
			const idx = STAGE_ORDER.indexOf(s);
			const status =
				stage === 'done' || idx < current ? 'done' : idx === current ? 'running' : 'pending';
			return { name: STAGE_LABEL[s], status, avgMs: stageAvgs?.[s] ?? null } as {
				name: string;
				status: 'done' | 'running' | 'pending' | 'error';
				avgMs: number | null;
			};
		});
	}

	// A single synthetic log line from the job's message (no log stream in the schema).
	function logsFor(job: ProcessingJob): string[] {
		const prefix = job.stage === 'failed' ? '[ERROR]' : '[INFO]';
		return [`${prefix} ${job.message || STAGE_LABEL[job.stage]}`];
	}

	// Format a millisecond duration compactly (820ms / 4.2s / 1.8m).
	function fmtMs(ms: number | null | undefined): string {
		if (ms === null || ms === undefined) return '—';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${(ms / 60_000).toFixed(1)}m`;
	}

	// ETA from the measured average job duration scaled by remaining progress.
	// Honest '—' when no timing data has been recorded yet (never invented).
	function etaFor(job: ProcessingJob): string {
		const s = statusOf(job.stage);
		if (s === 'completed' || s === 'failed') return '-';
		const avg = $stats.data?.avgDurationMs ?? null;
		if (avg === null) return '—';
		const remainingMs = avg * (Math.max(0, 100 - job.progress) / 100);
		return remainingMs < 1000 ? '<1s' : `~${fmtMs(remainingMs)}`;
	}

	// ── Filters ─────────────────────────────────────────────────────────────────
	let searchQuery = $state('');
	let filterTab = $state<'all' | 'active' | 'completed' | 'failed'>('all');
	let selectedId = $state<string | null>(null);

	const tabs = [
		{ id: 'all', label: 'All Jobs' },
		{ id: 'active', label: 'Active' },
		{ id: 'completed', label: 'Completed' },
		{ id: 'failed', label: 'Failed' }
	] as const;

	const filteredJobs = $derived.by(() => {
		const q = searchQuery.toLowerCase();
		return jobs.filter((job) => {
			const status = statusOf(job.stage);
			if (filterTab === 'active' && status !== 'processing') return false;
			if (filterTab === 'completed' && status !== 'completed') return false;
			if (filterTab === 'failed' && status !== 'failed') return false;
			if (
				q &&
				!job.id.toLowerCase().includes(q) &&
				!job.documentTitle.toLowerCase().includes(q)
			) {
				return false;
			}
			return true;
		});
	});

	const selectedJob = $derived(jobs.find((j) => j.id === selectedId) ?? null);
	const selectedSteps = $derived(selectedJob ? stepsFor(selectedJob.stage) : []);
	const activeCount = $derived(jobs.filter((j) => statusOf(j.stage) === 'processing').length);

	// Real header-card values from /api/processing/stats (null = honest "no data yet").
	const successRate = $derived($stats.data?.successRate ?? null);
	const chunkCount = $derived($stats.data?.chunks ?? null);
	const claimCount = $derived($stats.data?.claims ?? null);
	const avgDurationMs = $derived($stats.data?.avgDurationMs ?? null);
	const throughput = $derived($stats.data?.throughput24h ?? null);

	// ── Live progress via SSE (browser only) ─────────────────────────────────────
	onMount(() => {
		if (!browser) return;
		let es: EventSource | null = null;
		try {
			es = new EventSource(api.baseUrl + '/api/processing/stream');
			es.onmessage = (evt) => {
				try {
					const payload = JSON.parse(evt.data) as
						| { id: string; stage: ProcessingStage; progress: number; message?: string }
						| { id: string; stage: ProcessingStage; progress: number; message?: string }[];
					const updates = Array.isArray(payload) ? payload : [payload];
					for (const u of updates) {
						if (!u?.id) continue;
						liveOverrides[u.id] = {
							stage: u.stage,
							progress: u.progress,
							message: u.message
						};
					}
					// A terminal transition (done/failed) invalidates the snapshot so counts settle.
					if (updates.some((u) => u.stage === 'done' || u.stage === 'failed')) {
						qc.invalidateQueries({ queryKey: ['processing'] });
					}
				} catch {
					// Ignore malformed frames.
				}
			};
			es.onerror = () => {
				// Stream unavailable (e.g. mock backend) — the table still renders the snapshot.
				es?.close();
			};
		} catch {
			// EventSource unsupported / URL invalid — no-op.
		}
		return () => es?.close();
	});
</script>

<main class="flex h-full w-full overflow-hidden">
	<!-- Main scroll region -->
	<div class="flex-1 overflow-y-auto">
		<div class="mx-auto max-w-6xl space-y-8 p-6 md:p-8">
			<header class="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
				<div>
					<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
						<Server class="h-6 w-6 text-indigo-400" />
						Processing Pipeline
					</h1>
					<p class="mt-1 text-sm text-zinc-400">
						Monitor background workers for OCR, chunking, GraphRAG extraction, and indexing.
					</p>
				</div>
				<div class="relative">
					<Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500" />
					<input
						type="text"
						placeholder="Search job ID or file..."
						bind:value={searchQuery}
						class="w-full rounded-md border border-zinc-800 bg-zinc-950/50 py-2 pr-3 pl-9 text-sm text-zinc-300 focus:border-indigo-500/50 focus:outline-none sm:w-64 md:w-80"
					/>
				</div>
			</header>

			<!-- Summary stats -->
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
				{#if $processing.isLoading}
					{#each Array(4) as _, i (i)}
						<Skeleton class="h-[104px] rounded-xl" />
					{/each}
				{:else}
					<div class="glass-panel rounded-xl border border-zinc-800 p-5">
						<div class="mb-3 flex items-center justify-between">
							<h3 class="flex items-center gap-2 text-sm font-medium text-zinc-400">
								<RefreshCcw class={cn('h-4 w-4', activeCount > 0 && 'animate-spin')} /> Active Jobs
							</h3>
						</div>
						<div class="text-3xl font-bold text-zinc-100">{activeCount}</div>
					</div>
					<div class="glass-panel rounded-xl border border-zinc-800 p-5">
						<div class="mb-3 flex items-center justify-between">
							<h3 class="flex items-center gap-2 text-sm font-medium text-zinc-400">
								<FileSearch class="h-4 w-4" /> Success Rate
							</h3>
						</div>
						{#if successRate !== null}
							<div
								class={cn(
									'text-3xl font-bold',
									successRate >= 0.9 ? 'text-emerald-400' : 'text-amber-400'
								)}
							>
								{(successRate * 100).toFixed(1)}%
							</div>
							{#if throughput}
								<p class="mt-1 text-xs text-zinc-500">
									{throughput.completed} done · {throughput.failed} failed (24h)
								</p>
							{/if}
						{:else}
							<div class="text-3xl font-bold text-zinc-500">—</div>
							<p class="mt-1 text-xs text-zinc-500">No completed or failed jobs yet</p>
						{/if}
					</div>
					<div class="glass-panel rounded-xl border border-zinc-800 p-5">
						<div class="mb-3 flex items-center justify-between">
							<h3 class="flex items-center gap-2 text-sm font-medium text-zinc-400">
								<Activity class="h-4 w-4" /> Total Chunks
							</h3>
						</div>
						<div class="text-3xl font-bold text-zinc-100">
							{chunkCount === null ? '—' : chunkCount.toLocaleString('en-US')}
						</div>
						{#if claimCount !== null}
							<p class="mt-1 text-xs text-zinc-500">
								{claimCount.toLocaleString('en-US')} claims extracted
							</p>
						{/if}
					</div>
					<div class="glass-panel rounded-xl border border-zinc-800 p-5">
						<div class="mb-3 flex items-center justify-between">
							<h3 class="flex items-center gap-2 text-sm font-medium text-zinc-400">
								<ArrowRightCircle class="h-4 w-4" /> Avg Process Time
							</h3>
						</div>
						<div class="flex items-baseline gap-2">
							<div class="text-3xl font-bold text-zinc-100">{fmtMs(avgDurationMs)}</div>
							<span class="text-xs text-zinc-500">Per job, queued → done</span>
						</div>
						{#if avgDurationMs === null}
							<p class="mt-1 text-xs text-zinc-500">Appears once timed jobs complete</p>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Jobs table -->
			<div class="glass-panel flex flex-col overflow-hidden rounded-xl border-zinc-800">
				<!-- Tabs -->
				<div
					class="flex items-center gap-1 overflow-x-auto border-b border-zinc-800 bg-zinc-900/50 px-2 pt-2"
				>
					{#each tabs as tab (tab.id)}
						<button
							onclick={() => (filterTab = tab.id)}
							class={cn(
								'border-b-2 px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors',
								filterTab === tab.id
									? 'border-indigo-500 text-zinc-100'
									: 'rounded-t-lg border-transparent text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
							)}
						>
							{tab.label}
						</button>
					{/each}
				</div>

				{#if $processing.isLoading}
					<div class="space-y-3 p-6">
						{#each Array(4) as _, i (i)}
							<Skeleton class="h-12 rounded-md" />
						{/each}
					</div>
				{:else if $processing.isError}
					<div class="px-6 py-12 text-center text-sm text-rose-300">
						Failed to load the processing queue. Please try again.
					</div>
				{:else}
					<div class="w-full overflow-x-auto">
						<table class="w-full text-left text-sm">
							<thead
								class="border-b border-zinc-800/50 bg-zinc-950/80 text-xs font-medium tracking-wider text-zinc-500 uppercase"
							>
								<tr>
									<th class="px-6 py-4">Job ID</th>
									<th class="px-6 py-4">Document</th>
									<th class="px-6 py-4">Current Stage</th>
									<th class="w-48 px-6 py-4 text-center">Progress</th>
									<th class="px-6 py-4 text-right">ETA</th>
								</tr>
							</thead>
							<tbody class="divide-y divide-zinc-800/50 text-zinc-300">
								{#if filteredJobs.length === 0}
									<tr>
										<td colspan="5" class="px-6 py-12 text-center text-zinc-500">
											No jobs found matching your filters.
										</td>
									</tr>
								{:else}
									{#each filteredJobs as job (job.id)}
										{@const status = statusOf(job.stage)}
										<tr
											onclick={() => (selectedId = job.id)}
											class="group cursor-pointer transition-colors hover:bg-zinc-900/40"
										>
											<td
												class="px-6 py-4 font-mono text-zinc-400 transition-colors group-hover:text-indigo-400"
											>
												{job.id}
											</td>
											<td class="px-6 py-4 font-medium text-zinc-200">{job.documentTitle}</td>
											<td class="px-6 py-4">
												<div class="flex items-center gap-2">
													{#if status === 'processing'}
														<RefreshCcw class="h-3.5 w-3.5 shrink-0 animate-spin text-indigo-400" />
													{:else if status === 'completed'}
														<CheckCircle2 class="h-3.5 w-3.5 shrink-0 text-emerald-400" />
													{:else}
														<AlertCircle class="h-3.5 w-3.5 shrink-0 text-rose-400" />
													{/if}
													<span
														class={cn(
															'max-w-[200px] truncate text-xs',
															status === 'completed'
																? 'text-emerald-400'
																: status === 'failed'
																	? 'text-rose-400'
																	: 'text-indigo-300'
														)}
													>
														{STAGE_LABEL[job.stage]}
													</span>
												</div>
											</td>
											<td class="px-6 py-4">
												<div class="flex items-center justify-center gap-2">
													<div
														class="h-1.5 w-24 overflow-hidden rounded-full border border-zinc-800 bg-zinc-900"
													>
														<div
															class={cn(
																'h-full rounded-full transition-all duration-500',
																status === 'completed'
																	? 'bg-emerald-500'
																	: status === 'failed'
																		? 'bg-rose-500'
																		: 'bg-indigo-500'
															)}
															style="width: {job.progress}%"
														></div>
													</div>
													<span class="w-8 text-right font-mono text-[10px] text-zinc-500">
														{Math.round(job.progress)}%
													</span>
												</div>
											</td>
											<td class="px-6 py-4 text-right font-mono whitespace-nowrap text-zinc-400">
												{etaFor(job)}
											</td>
										</tr>
									{/each}
								{/if}
							</tbody>
						</table>
					</div>
				{/if}
			</div>
		</div>
	</div>

	<!-- Job detail side panel -->
	{#if selectedJob}
		{@const status = statusOf(selectedJob.stage)}
		<aside
			transition:fly={{ x: 400, duration: 300, opacity: 1 }}
			class="relative z-20 flex h-full w-[400px] shrink-0 flex-col overflow-hidden border-l border-zinc-800 bg-zinc-950 shadow-2xl"
		>
			<div
				class="flex h-16 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-6"
			>
				<h2 class="flex items-center gap-2 font-semibold text-zinc-100">
					<FileText class="h-4 w-4 text-indigo-400" />
					Job Details
				</h2>
				<button
					onclick={() => (selectedId = null)}
					class="-mr-2 rounded-md p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
				>
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="flex-1 space-y-6 overflow-y-auto p-6">
				<!-- Metadata -->
				<div>
					<h3 class="mb-2 text-xs font-semibold tracking-wider text-zinc-500 uppercase">Metadata</h3>
					<div class="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
						<div class="flex items-center justify-between text-sm">
							<span class="text-zinc-500">Job ID</span>
							<span class="flex items-center gap-1.5">
								<span class="font-mono text-xs text-zinc-200">{selectedJob.id}</span>
								<button
									onclick={() => copyToClipboard(selectedJob.id, 'Job ID copied')}
									class="rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
									aria-label="Copy job ID"
								>
									<Copy class="h-3 w-3" />
								</button>
							</span>
						</div>
						<div class="flex justify-between text-sm">
							<span class="text-zinc-500">File</span>
							<span class="ml-4 truncate text-zinc-200" title={selectedJob.documentTitle}>
								{selectedJob.documentTitle}
							</span>
						</div>
						<div class="flex justify-between text-sm">
							<span class="text-zinc-500">Started</span>
							<span class="text-zinc-200">{selectedJob.startedAt}</span>
						</div>
						<div class="flex justify-between text-sm">
							<span class="text-zinc-500">Status</span>
							<span
								class={cn(
									'rounded border px-2 py-0.5 text-xs font-medium capitalize',
									status === 'completed'
										? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
										: status === 'failed'
											? 'border-rose-500/20 bg-rose-500/10 text-rose-400'
											: 'border-indigo-500/20 bg-indigo-500/10 text-indigo-400'
								)}
							>
								{status}
							</span>
						</div>
					</div>
				</div>

				<!-- Pipeline steps -->
				<div>
					<h3 class="mb-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">
						Pipeline Steps
					</h3>
					{#if selectedSteps.length > 0}
						<div class="relative ml-1 space-y-4 border-l-2 border-zinc-800/80 pl-3">
							{#each selectedSteps as step, i (i)}
								<div class="relative">
									<div
										class={cn(
											'absolute top-1 -left-[18px] h-2.5 w-2.5 rounded-full border-2 bg-zinc-950',
											step.status === 'done'
												? 'border-emerald-500'
												: step.status === 'error'
													? 'border-rose-500'
													: step.status === 'running'
														? 'border-indigo-500'
														: 'border-zinc-700'
										)}
									></div>
									<div class="flex items-start justify-between">
										<span
											class={cn(
												'text-sm',
												step.status === 'pending' ? 'text-zinc-500' : 'text-zinc-300'
											)}
										>
											{step.name}
										</span>
										{#if step.avgMs !== null}
											<span class="ml-2 shrink-0 font-mono text-[10px] text-zinc-600">
												{fmtMs(step.avgMs)} avg
											</span>
										{/if}
									</div>
									{#if step.status === 'running'}
										<p class="mt-1 animate-pulse text-[10px] text-indigo-400 italic">Running...</p>
									{/if}
								</div>
							{/each}
						</div>
					{:else}
						<div class="text-sm text-zinc-500">No step details available.</div>
					{/if}
				</div>

				<!-- Recent logs -->
				<div>
					<div class="mb-2 flex items-center justify-between">
						<h3 class="text-xs font-semibold tracking-wider text-zinc-500 uppercase">Recent Logs</h3>
						<button
							onclick={() => copyToClipboard(logsFor(selectedJob).join('\n'), 'Logs copied')}
							class="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
							aria-label="Copy logs"
						>
							<Copy class="h-3.5 w-3.5" />
						</button>
					</div>
					<div class="h-48 overflow-y-auto rounded-lg border border-zinc-800 bg-[#0c0c0c] p-3">
						<pre
							class="text-[10px] leading-relaxed font-mono whitespace-pre-wrap text-zinc-400">{logsFor(
								selectedJob
							).join('\n')}{#if status === 'processing'}<span
									class="ml-1 inline-block h-3 w-1.5 animate-pulse bg-indigo-500 align-middle"
								></span>{/if}</pre>
					</div>
				</div>
			</div>

			<!-- Actions -->
			{#if status === 'processing' || status === 'failed'}
				<div class="border-t border-zinc-800 bg-zinc-900/50 p-4">
					{#if copyNotice}
						<div
							transition:fade={{ duration: 120 }}
							class="mb-2 text-center text-[11px] font-medium text-emerald-400"
						>
							{copyNotice}
						</div>
					{/if}
					<div class="flex gap-2">
						{#if status === 'processing'}
							<button
								onclick={() => $cancelMutation.mutate(selectedJob.id)}
								disabled={$cancelMutation.isPending}
								class="flex flex-1 items-center justify-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm font-medium text-rose-400 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-50"
							>
								<Square class="h-4 w-4" fill="currentColor" />
								{$cancelMutation.isPending ? 'Cancelling…' : 'Cancel Job'}
							</button>
						{:else}
							<button
								onclick={() => $retryMutation.mutate(selectedJob.id)}
								disabled={$retryMutation.isPending}
								class="flex flex-1 items-center justify-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
							>
								<Play class="h-4 w-4" fill="currentColor" />
								{$retryMutation.isPending ? 'Retrying…' : 'Retry Job'}
							</button>
						{/if}
					</div>
				</div>
			{/if}
		</aside>
	{/if}
</main>
