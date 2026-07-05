<script lang="ts">
	import { page } from '$app/state';
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { fade } from 'svelte/transition';
	import {
		FileText,
		Activity,
		CheckCircle2,
		ChevronLeft,
		Layers,
		RefreshCw,
		ExternalLink,
		Loader2,
		AlertTriangle,
		XCircle,
		Clock
	} from '@lucide/svelte';
	import { ApiError } from '@insightlibrary/api-client';
	import { api } from '$lib/api';
	import { Card, Button, Skeleton } from '$lib/components/ui';

	// Dynamic route params — always present when this route matches.
	const folderId = $derived(page.params.id!);
	const docId = $derived(page.params.docId!);
	const queryClient = useQueryClient();

	const query = $derived(
		createQuery({ queryKey: ['document', docId], queryFn: () => api.getDocument(docId) })
	);
	// Real parse structure + coverage accounting + pipeline state (A7/B8).
	const structureQuery = $derived(
		createQuery({
			queryKey: ['document-structure', docId],
			queryFn: () => api.getDocumentStructure(docId),
			refetchInterval: (q) => {
				// Poll while the pipeline is running so the stage list stays live.
				const stage = q.state.data?.job?.stage;
				return stage && stage !== 'done' && stage !== 'failed' ? 4000 : false;
			}
		})
	);

	// Re-Index → the real retry endpoint (re-enqueues ingestion for this doc).
	let reindexNotice = $state('');
	const reindexMutation = createMutation({
		mutationFn: () => api.retryJob(`pj_${docId}`),
		onSuccess: () => {
			reindexNotice = 'Re-index queued — the pipeline will re-run this document.';
			queryClient.invalidateQueries({ queryKey: ['document-structure', docId] });
			queryClient.invalidateQueries({ queryKey: ['document', docId] });
		},
		onError: (e) => {
			reindexNotice =
				e instanceof ApiError && e.status === 404
					? 'No processing record exists for this document yet — upload it again to index it.'
					: 'Re-index failed — check the processing console.';
		}
	});

	function viewSource() {
		window.open(`${api.baseUrl}/api/documents/${docId}/download`, '_blank', 'noopener');
	}

	const STATUS_BADGE: Record<string, string> = {
		indexed: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
		processing: 'border-amber-500/20 bg-amber-500/10 text-amber-400',
		needs_review: 'border-amber-500/20 bg-amber-500/10 text-amber-400',
		failed: 'border-rose-500/20 bg-rose-500/10 text-rose-400'
	};

	// Canonical pipeline order (packages/schemas processingStageSchema).
	const STAGE_ORDER = [
		'queued',
		'extract',
		'parse',
		'chunk',
		'contextualize',
		'embed',
		'index',
		'claims',
		'correlate',
		'graph',
		'refine',
		'done'
	];
	const STAGE_LABELS: Record<string, string> = {
		queued: 'Queued',
		extract: 'Download & Text Extraction',
		parse: 'Structure Parsing (pages, blocks)',
		chunk: 'Semantic Chunking',
		contextualize: 'Contextual Prefixes',
		embed: 'Embeddings',
		index: 'FTS + Vector Index',
		claims: 'Claim Extraction',
		correlate: 'Dedup / Conflicts / Graph',
		graph: 'Graph Build',
		refine: 'Refinery',
		done: 'Complete',
		failed: 'Failed'
	};

	function fmtDuration(ms: number): string {
		if (ms < 1000) return '<1s';
		const s = Math.round(ms / 1000);
		if (s < 60) return `${s}s`;
		return `${Math.floor(s / 60)}m ${s % 60}s`;
	}

	// Derive a real stage timeline from processing_jobs.stages timestamps.
	type StageRow = { stage: string; label: string; status: 'complete' | 'running' | 'failed'; time: string | null };
	const stageRows = $derived.by<StageRow[]>(() => {
		const job = $structureQuery.data?.job;
		if (!job) return [];
		if (!job.stages) {
			// Pre-0011 rows carry no per-stage timestamps — show the live stage only.
			return [
				{
					stage: job.stage,
					label: STAGE_LABELS[job.stage] ?? job.stage,
					status: job.stage === 'failed' ? 'failed' : job.stage === 'done' ? 'complete' : 'running',
					time: job.message
				}
			];
		}
		const entries = Object.entries(job.stages)
			.map(([stage, ts]) => ({ stage, at: Date.parse(ts) }))
			.filter((e) => Number.isFinite(e.at))
			.sort((a, b) => a.at - b.at || STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));
		return entries.map((e, i) => {
			const next = entries[i + 1];
			const isLast = i === entries.length - 1;
			const status: StageRow['status'] =
				e.stage === 'failed'
					? 'failed'
					: !isLast || e.stage === 'done'
						? 'complete'
						: job.stage === 'failed'
							? 'failed'
							: 'running';
			const time =
				e.stage === 'done' || e.stage === 'failed'
					? new Date(e.at).toLocaleString()
					: next
						? fmtDuration(next.at - e.at)
						: status === 'running'
							? job.message || 'in progress…'
							: '';
			return { stage: e.stage, label: STAGE_LABELS[e.stage] ?? e.stage, status, time };
		});
	});

	const COVERAGE_LABELS: Record<string, { label: string; bar: string }> = {
		chunked: { label: 'Chunked (indexed for search)', bar: 'bg-emerald-400' },
		claimed: { label: 'Claimed (in the SSOT)', bar: 'bg-indigo-400' },
		unaccounted: { label: 'Unaccounted', bar: 'bg-amber-400' },
		ignored: { label: 'Ignored', bar: 'bg-zinc-500' },
		low_confidence: { label: 'Low confidence', bar: 'bg-rose-400' },
		needs_review: { label: 'Needs review', bar: 'bg-amber-400' }
	};

	const KIND_LABELS: Record<string, string> = {
		text: 'Text blocks',
		heading: 'Headings',
		figure: 'Figures',
		table: 'Tables',
		list: 'Lists',
		code: 'Code'
	};
</script>

<div class="mx-auto max-w-6xl space-y-8">
	<div>
		<a
			href="/folders/{folderId}"
			class="flex w-fit items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
		>
			<ChevronLeft class="h-4 w-4" /> Back to Folder
		</a>
	</div>

	{#if $query.isLoading}
		<div class="space-y-6">
			<Skeleton class="h-24 w-full" />
			<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
				<Skeleton class="h-80 lg:col-span-1" />
				<Skeleton class="h-80 lg:col-span-2" />
			</div>
		</div>
	{:else if $query.data}
		{@const doc = $query.data}
		{@const structure = $structureQuery.data}
		<div in:fade={{ duration: 200 }} class="space-y-8">
			<!-- Header -->
			<div class="flex flex-col justify-between gap-6 md:flex-row md:items-start">
				<div class="flex items-start gap-4">
					<div
						class="flex h-20 w-16 shrink-0 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 shadow-xl"
					>
						<FileText class="h-8 w-8 text-indigo-400/50" />
					</div>
					<div>
						<h1 class="text-2xl font-bold tracking-tight text-zinc-100">{doc.title}</h1>
						<p class="mt-1 text-zinc-400">
							{doc.type.toUpperCase()} · {doc.pages.toLocaleString()} pages · {doc.topics} topics
						</p>
						<div class="mt-3 flex items-center gap-3">
							<span
								class="flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium {STATUS_BADGE[doc.status] ?? STATUS_BADGE.processing}"
							>
								{#if doc.status === 'indexed'}
									<CheckCircle2 class="h-3.5 w-3.5" />
								{:else if doc.status === 'failed'}
									<XCircle class="h-3.5 w-3.5" />
								{:else}
									<Clock class="h-3.5 w-3.5" />
								{/if}
								{doc.statusLabel}
							</span>
							<span class="text-xs text-zinc-500">
								Uploaded {new Date(doc.uploadedAt).toLocaleDateString()}
							</span>
						</div>
					</div>
				</div>
				<div class="flex flex-col items-end gap-2">
					<div class="flex items-center gap-3">
						<Button
							variant="outline"
							onclick={viewSource}
							disabled={structure ? !structure.hasSource : false}
							title={structure && !structure.hasSource
								? 'No source file is stored for this document'
								: 'Open the original uploaded file'}
						>
							<ExternalLink class="h-4 w-4" /> View Source File
						</Button>
						<Button onclick={() => $reindexMutation.mutate()} disabled={$reindexMutation.isPending}>
							{#if $reindexMutation.isPending}
								<Loader2 class="h-4 w-4 animate-spin" /> Queuing…
							{:else}
								<RefreshCw class="h-4 w-4" /> Re-Index Document
							{/if}
						</Button>
					</div>
					{#if reindexNotice}
						<p class="text-xs text-zinc-400" role="status">{reindexNotice}</p>
					{/if}
				</div>
			</div>

			<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
				<!-- Left: Stats & Pipeline -->
				<div class="space-y-6 lg:col-span-1">
					<Card class="p-5">
						<h3
							class="mb-4 flex items-center gap-2 border-b border-zinc-800/50 pb-2 text-sm font-medium text-zinc-400"
						>
							<Activity class="h-4 w-4 text-indigo-400" /> Extraction Stats
						</h3>
						{#if $structureQuery.isLoading}
							<div class="space-y-3">
								<Skeleton class="h-4 w-full" />
								<Skeleton class="h-4 w-full" />
								<Skeleton class="h-4 w-full" />
							</div>
						{:else if structure && structure.source === 'postgres'}
							<div class="space-y-4">
								<div class="flex items-end justify-between">
									<span class="text-sm text-zinc-400">Pages Parsed</span>
									<span class="font-mono text-zinc-200"
										>{(structure.pages?.count || doc.pages).toLocaleString()}</span
									>
								</div>
								<div class="flex items-end justify-between">
									<span class="text-sm text-zinc-400">Blocks Extracted</span>
									<span class="font-mono text-zinc-200"
										>{(structure.blocks?.total ?? 0).toLocaleString()}</span
									>
								</div>
								<div class="flex items-end justify-between">
									<span class="text-sm text-zinc-400">Chunks Indexed</span>
									<span class="font-mono text-zinc-200"
										>{(structure.chunks ?? 0).toLocaleString()}</span
									>
								</div>
								<div class="flex items-end justify-between">
									<span class="text-sm text-zinc-400">Figures & Tables</span>
									<span class="font-mono text-zinc-200"
										>{(
											(structure.blocks?.byKind?.figure ?? 0) + (structure.blocks?.byKind?.table ?? 0)
										).toLocaleString()}</span
									>
								</div>
								{#if structure.pages?.width && structure.pages?.height}
									<div class="flex items-end justify-between">
										<span class="text-sm text-zinc-400">Page Dimensions</span>
										<span class="font-mono text-xs text-zinc-400"
											>{Math.round(structure.pages.width)} × {Math.round(structure.pages.height)}</span
										>
									</div>
								{/if}
							</div>
						{:else}
							<p class="text-sm text-zinc-500">
								No parse structure recorded for this document{structure?.source === 'memory'
									? ' (running without a database)'
									: ''}.
							</p>
						{/if}
					</Card>

					<Card class="p-5">
						<h3 class="mb-4 border-b border-zinc-800/50 pb-2 text-sm font-medium text-zinc-400">
							Processing Pipeline
						</h3>
						{#if $structureQuery.isLoading}
							<div class="space-y-3">
								<Skeleton class="h-4 w-full" />
								<Skeleton class="h-4 w-full" />
							</div>
						{:else if stageRows.length > 0}
							<div class="space-y-4">
								{#each stageRows as stage (stage.stage)}
									<div class="flex items-start gap-3">
										<div class="mt-0.5">
											{#if stage.status === 'complete'}
												<CheckCircle2 class="h-4 w-4 text-emerald-400" />
											{:else if stage.status === 'running'}
												<Loader2 class="h-4 w-4 animate-spin text-amber-400" />
											{:else}
												<XCircle class="h-4 w-4 text-rose-400" />
											{/if}
										</div>
										<div>
											<p class="text-sm font-medium text-zinc-300">{stage.label}</p>
											{#if stage.time}
												<p class="font-mono text-xs text-zinc-500">{stage.time}</p>
											{/if}
										</div>
									</div>
								{/each}
							</div>
							{#if $structureQuery.data?.job?.stage === 'failed'}
								<p class="mt-4 rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
									{$structureQuery.data.job.message || 'Processing failed.'}
								</p>
							{/if}
						{:else}
							<p class="text-sm text-zinc-500">No processing record for this document.</p>
						{/if}
					</Card>
				</div>

				<!-- Right: Coverage accounting & block composition -->
				<div class="space-y-6 lg:col-span-2">
					<Card class="overflow-hidden">
						<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-5 py-4">
							<h3 class="flex items-center gap-2 text-sm font-medium text-zinc-200">
								<Layers class="h-4 w-4 text-emerald-400" /> Coverage Accounting
							</h3>
							{#if structure?.coverage && structure.coverage.total > 0}
								<span class="text-xs text-zinc-500">{structure.coverage.total.toLocaleString()} blocks</span>
							{/if}
						</div>
						<div class="p-5">
							{#if $structureQuery.isLoading}
								<Skeleton class="h-24 w-full" />
							{:else if structure?.coverage && structure.coverage.total > 0}
								{@const cov = structure.coverage}
								<div class="space-y-4">
									{#each Object.entries(cov.byStatus).sort((a, b) => b[1] - a[1]) as [status, n] (status)}
										{@const meta = COVERAGE_LABELS[status] ?? { label: status, bar: 'bg-zinc-500' }}
										{@const p = cov.total > 0 ? (n / cov.total) * 100 : 0}
										<div>
											<div class="mb-1 flex items-center justify-between text-sm">
												<span class="text-zinc-300">{meta.label}</span>
												<span class="font-mono text-xs text-zinc-400"
													>{n.toLocaleString()} · {Math.round(p * 10) / 10}%</span
												>
											</div>
											<div class="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
												<div class="h-full rounded-full {meta.bar}" style="width: {p}%"></div>
											</div>
										</div>
									{/each}
								</div>
								{#if cov.unaccountedPct > 25}
									<p class="mt-4 flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
										<AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
										{cov.unaccountedPct}% of extracted blocks are not yet chunked or claimed — re-index
										to improve coverage.
									</p>
								{/if}
							{:else}
								<p class="text-sm text-zinc-500">
									No coverage data yet — it is recorded when the ingestion pipeline parses this
									document.
								</p>
							{/if}
						</div>
					</Card>

					<Card class="overflow-hidden">
						<div class="border-b border-zinc-800 bg-zinc-900/50 px-5 py-4">
							<h3 class="flex items-center gap-2 text-sm font-medium text-zinc-200">
								<FileText class="h-4 w-4 text-indigo-400" /> Block Composition
							</h3>
						</div>
						{#if $structureQuery.isLoading}
							<div class="p-5"><Skeleton class="h-16 w-full" /></div>
						{:else if structure?.blocks && structure.blocks.total > 0}
							<div class="overflow-x-auto">
								<table class="w-full text-left text-sm">
									<thead
										class="border-b border-zinc-800/50 bg-zinc-950/50 text-xs font-medium text-zinc-500"
									>
										<tr>
											<th class="px-5 py-3">Block Kind</th>
											<th class="px-5 py-3">Count</th>
											<th class="px-5 py-3">Share</th>
										</tr>
									</thead>
									<tbody class="divide-y divide-zinc-800/50">
										{#each Object.entries(structure.blocks.byKind).sort((a, b) => b[1] - a[1]) as [kind, n] (kind)}
											{@const p = structure.blocks.total > 0 ? (n / structure.blocks.total) * 100 : 0}
											<tr class="transition-colors hover:bg-zinc-900/40">
												<td class="px-5 py-3 font-medium text-zinc-300">{KIND_LABELS[kind] ?? kind}</td>
												<td class="px-5 py-3 font-mono text-zinc-400">{n.toLocaleString()}</td>
												<td class="px-5 py-3">
													<div class="flex items-center gap-2">
														<div class="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-800">
															<div class="h-full rounded-full bg-indigo-500" style="width: {p}%"></div>
														</div>
														<span class="font-mono text-xs text-zinc-400">{Math.round(p)}%</span>
													</div>
												</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						{:else}
							<div class="p-5">
								<p class="text-sm text-zinc-500">No blocks extracted for this document yet.</p>
							</div>
						{/if}
					</Card>
				</div>
			</div>
		</div>
	{:else}
		<div
			class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-zinc-800 py-16 text-center"
		>
			<AlertTriangle class="h-8 w-8 text-zinc-600" />
			<p class="text-sm text-zinc-500">Document not found.</p>
			<a href="/folders/{folderId}" class="text-sm text-indigo-400 hover:text-indigo-300"
				>Return to folder →</a
			>
		</div>
	{/if}
</div>
