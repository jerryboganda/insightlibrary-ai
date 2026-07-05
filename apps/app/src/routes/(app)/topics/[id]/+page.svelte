<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { fade, scale } from 'svelte/transition';
	import {
		BrainCircuit,
		HeartPulse,
		BadgeCheck,
		Layers,
		GitMerge,
		History,
		FileText,
		CheckCircle2,
		MessageSquareWarning,
		Plus,
		X,
		Trash2,
		RefreshCw,
		RotateCcw,
		AlertTriangle,
		ListChecks,
		Database
	} from '@lucide/svelte';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import { iconByName } from '$lib/icons';
	import { cn } from '$lib/utils';
	import type { CoverageCell, Source } from '@insightlibrary/schemas';
	import type { TopicClaim, TopicVerifyReason } from '@insightlibrary/api-client';

	const id = $derived(page.params.id ?? '');
	const query = $derived(createQuery({ queryKey: ['topic', id], queryFn: () => api.getTopic(id) }));
	const sourcesQuery = createQuery({ queryKey: ['sources'], queryFn: () => api.listSources() });
	const qc = useQueryClient();

	// ── Tabs (deep-linkable via ?tab= so other pages can link straight in) ────
	const TAB_IDS = ['ssot', 'coverage', 'claims', 'delta', 'history'] as const;
	type TabId = (typeof TAB_IDS)[number];
	const activeTab = $derived.by<TabId>(() => {
		const t = page.url.searchParams.get('tab');
		return (TAB_IDS as readonly string[]).includes(t ?? '') ? (t as TabId) : 'ssot';
	});
	function selectTab(tab: TabId) {
		const url = new URL(page.url);
		if (tab === 'ssot') url.searchParams.delete('tab');
		else url.searchParams.set('tab', tab);
		goto(url, { replaceState: true, keepFocus: true, noScroll: true });
	}

	const tabs = [
		{ id: 'ssot', label: 'Canonical SSOT', icon: FileText },
		{ id: 'coverage', label: 'Source Coverage Matrix', icon: Layers },
		{ id: 'claims', label: 'Claims Inspector', icon: ListChecks },
		{ id: 'delta', label: 'Delta Intel Feed', icon: GitMerge },
		{ id: 'history', label: 'Version History', icon: History }
	] as const;

	// Lazy per-tab queries — fetched on first open, cached afterwards.
	const versionsQuery = $derived(
		createQuery({
			queryKey: ['topic-versions', id],
			queryFn: () => api.listTopicVersions(id),
			enabled: activeTab === 'history'
		})
	);
	const claimsQuery = $derived(
		createQuery({
			queryKey: ['topic-claims', id],
			queryFn: () => api.getTopicClaims(id),
			enabled: activeTab === 'claims'
		})
	);

	// New claims persist to the SSOT via the API, then the topic query refetches.
	const addClaim = createMutation({
		mutationFn: (input: { sectionId: string; content: string; citations: string[] }) =>
			api.addClaim(id, input),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['topic', id] })
	});
	// Strict verification of the CURRENT page — read-only, no recompose (B11).
	const verify = createMutation({ mutationFn: () => api.verifyTopic(id) });
	// Evidence-only recompose + verifier gate → writes a new topic version.
	const regenerate = createMutation({
		mutationFn: () => api.regenerateTopic(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ['topic', id] });
			qc.invalidateQueries({ queryKey: ['topic-versions', id] });
			qc.invalidateQueries({ queryKey: ['topic-claims', id] });
			$verify.reset(); // the page changed — a previous verdict no longer applies
		}
	});
	// Restore an old snapshot as the live SSOT (records a NEW version, editor+).
	const restore = createMutation({
		mutationFn: (version: number) => api.restoreTopicVersion(id, version),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ['topic', id] });
			qc.invalidateQueries({ queryKey: ['topic-versions', id] });
			$verify.reset();
		}
	});
	let confirmRestore = $state<number | null>(null);

	let modalSection = $state<string | null>(null);
	let claimText = $state('');
	let citations = $state<string[]>([]);
	let citeInput = $state('');

	// ── Sources registry drives the hero avatars + coverage columns (A5) ──────
	const registeredSources = $derived($sourcesQuery.data ?? []);
	const contributingSources = $derived.by(() => {
		const sections = $query.data?.topic.sections ?? [];
		const cited = new Set<string>();
		for (const sec of sections) for (const c of sec.claims) for (const token of c.citations) cited.add(token);
		const hit = registeredSources.filter((s) => cited.has(s.id));
		return (hit.length ? hit : registeredSources).slice(0, 6);
	});
	function sourceInitial(s: Source): string {
		const suffix = s.id.split('-').pop() ?? '';
		if (suffix.length > 0 && suffix.length <= 2) return suffix.toUpperCase();
		const words = s.name.replace(/[^a-zA-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
		return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
	}

	// Coverage matrix computed from the live SSOT claims × the source registry
	// (same grading as the server's coverage.ts, but columns are real sources).
	function grade(count: number): CoverageCell {
		if (count >= 2) return 'Strong';
		if (count === 1) return 'Medium';
		return 'None';
	}
	function rowStatus(cells: CoverageCell[]): string {
		if (cells.includes('Strong')) return 'Covered';
		if (cells.includes('Medium')) return 'Improved';
		return 'Needs expansion';
	}
	const coverageMatrix = $derived.by(() => {
		const sections = $query.data?.topic.sections ?? [];
		if (!registeredSources.length) return [];
		return sections.map((section) => {
			const cells = registeredSources.map((s) =>
				grade(section.claims.filter((c) => c.citations.includes(s.id)).length)
			);
			return { aspect: section.title, cells, status: rowStatus(cells) };
		});
	});

	// ── Verification verdict helpers ──────────────────────────────────────────
	const verifyResult = $derived($verify.data ?? null);
	const unsupportedKeys = $derived.by(() => {
		const set = new Set<string>();
		for (const s of verifyResult?.sections ?? []) {
			for (const u of s.unsupported) set.add(`${s.sectionId}:${u.claimId}`);
		}
		return set;
	});
	const failedSections = $derived((verifyResult?.sections ?? []).filter((s) => s.unsupported.length > 0));
	const REASON_LABELS: Record<TopicVerifyReason, string> = {
		no_citation: 'No citation',
		citation_unmatched: 'Citation matches no evidence claim',
		not_entailed: 'Evidence does not entail this sentence'
	};

	// ── Claims inspector (A6) ─────────────────────────────────────────────────
	const CLAIM_STATUSES = ['all', 'active', 'conflicted', 'superseded', 'draft', 'retired'] as const;
	let claimStatusFilter = $state<(typeof CLAIM_STATUSES)[number]>('all');
	const allClaims = $derived($claimsQuery.data?.items ?? []);
	const filteredClaims = $derived(
		allClaims.filter((c) => claimStatusFilter === 'all' || c.status === claimStatusFilter)
	);
	function claimStatusCount(status: string): number {
		return status === 'all' ? allClaims.length : allClaims.filter((c) => c.status === status).length;
	}
	function claimStatusClass(status: TopicClaim['status']): string {
		if (status === 'active') return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400';
		if (status === 'conflicted') return 'border-rose-500/20 bg-rose-500/10 text-rose-400';
		if (status === 'draft') return 'border-amber-500/20 bg-amber-500/10 text-amber-400';
		return 'border-zinc-700 bg-zinc-800 text-zinc-400';
	}
	function provenanceToken(s: TopicClaim['sources'][number]): string {
		const ref = s.sourceRef ?? s.sourceId ?? s.documentId ?? s.chunkId ?? 'src';
		return s.locator ? `${ref} · ${s.locator}` : ref;
	}

	// Changelog/delta type → chip tone (shared across History + Delta).
	function changeTypeClass(type: string): string {
		if (type === 'conflict') return 'bg-rose-500/20 text-rose-400';
		if (type === 'citation') return 'bg-emerald-500/20 text-emerald-400';
		if (type === 'expand') return 'bg-blue-500/20 text-blue-400';
		if (type === 'new') return 'bg-indigo-500/20 text-indigo-400';
		if (type === 'restore') return 'bg-amber-500/20 text-amber-400';
		return 'bg-zinc-800 text-zinc-400';
	}

	function fmtTime(ts: string): string {
		const d = new Date(ts);
		if (Number.isNaN(d.getTime())) return ts;
		return d.toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}
	const pct = (f: number | null | undefined) => (f == null ? null : `${Math.round(f * 100)}%`);

	function openModal(sectionId: string) {
		modalSection = sectionId;
		claimText = '';
		citations = [];
		citeInput = '';
	}
	function addCitation() {
		if (citeInput.trim()) {
			citations = [...citations, citeInput.trim()];
			citeInput = '';
		}
	}
	function saveClaim() {
		if (!claimText.trim() || !modalSection) return;
		$addClaim.mutate({ sectionId: modalSection, content: claimText.trim(), citations });
		modalSection = null;
	}

	const cellClass = (c: CoverageCell) =>
		c === 'Strong'
			? 'text-emerald-400 font-semibold'
			: c === 'Medium'
				? 'text-amber-400'
				: c === 'Weak'
					? 'text-rose-400'
					: 'text-zinc-600';
</script>

{#if $query.isLoading}
	<div class="mx-auto max-w-5xl space-y-4"><Skeleton class="h-12 w-80" /><Skeleton class="h-64" /></div>
{:else if $query.data}
	{@const topic = $query.data.topic}
	{@const delta = $query.data.delta}
	<div class="-m-6 flex flex-col">
		<!-- Hero -->
		<div class="relative overflow-hidden border-b border-zinc-800 bg-zinc-950/30 px-6 py-8 md:px-10">
			<div class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(79,70,229,0.1),transparent_60%)]"></div>
			<div class="relative mx-auto flex max-w-5xl items-start justify-between">
				<div>
					<div class="mb-2 flex items-center gap-3">
						<div class="rounded-md bg-indigo-500/20 p-1.5 text-indigo-400"><BrainCircuit class="h-5 w-5" /></div>
						<span class="font-mono text-xs tracking-wider text-zinc-500 uppercase">SSOT Canonical Topic</span>
					</div>
					<h1 class="glow-text mb-2 text-3xl font-bold tracking-tight text-zinc-100 md:text-4xl">{topic.name}</h1>
					<div class="flex flex-wrap items-center gap-2">
						{#each topic.aliases as alias (alias)}
							<span class="rounded-full border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-400">AKA: {alias}</span>
						{/each}
					</div>
				</div>
				<div class="flex items-center gap-4 text-right">
					<div class="flex flex-col items-end">
						<span class="mb-1 text-xs font-medium text-zinc-500">Completeness Score</span>
						<span class="text-3xl font-bold text-emerald-400">{topic.health}%</span>
					</div>
					<div class="h-12 w-px bg-zinc-800"></div>
					<div class="text-left">
						<p class="mb-1 font-mono text-[10px] text-zinc-500">CONTRIBUTING SOURCES</p>
						{#if contributingSources.length}
							<div class="flex -space-x-2">
								{#each contributingSources as s (s.id)}
									<div class="flex h-7 w-7 items-center justify-center rounded-full border-2 border-zinc-950 bg-zinc-800 text-[10px] font-bold text-zinc-300" title="{s.name} ({s.id})">{sourceInitial(s)}</div>
								{/each}
							</div>
						{:else}
							<a href="/admin/sources" class="text-xs text-zinc-500 underline-offset-2 hover:text-indigo-300 hover:underline">No sources registered</a>
						{/if}
					</div>
				</div>
			</div>

			<div class="mx-auto mt-8 flex max-w-5xl overflow-x-auto border-b border-zinc-800">
				{#each tabs as tab (tab.id)}
					<button
						onclick={() => selectTab(tab.id)}
						class={cn(
							'relative flex shrink-0 items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
							activeTab === tab.id ? 'border-indigo-500 text-indigo-300' : 'border-transparent text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
						)}
					>
						<tab.icon class="h-4 w-4" /> {tab.label}
						{#if tab.id === 'delta'}<span class="ml-1 h-2 w-2 rounded-full bg-indigo-500"></span>{/if}
					</button>
				{/each}
			</div>
		</div>

		<div class="p-6 md:p-10">
			<div class="mx-auto max-w-5xl">
				{#if activeTab === 'ssot'}
					<div in:fade={{ duration: 150 }} class="space-y-8">
						<div class="flex items-center justify-between">
							<h2 class="flex items-center gap-2 text-lg font-semibold text-zinc-200"><HeartPulse class="h-5 w-5 text-indigo-400" /> Topic Master File</h2>
							<div class="flex items-center gap-2">
								<a href="/study/{topic.id}" class="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"><BrainCircuit class="h-3.5 w-3.5" /> Study Topic</a>
								<button onclick={() => $regenerate.mutate()} disabled={$regenerate.isPending || $verify.isPending} class="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"><RefreshCw class={`h-3.5 w-3.5 ${$regenerate.isPending ? 'animate-spin' : ''}`} /> {$regenerate.isPending ? 'Composing…' : 'Regenerate'}</button>
								<button onclick={() => $verify.mutate()} disabled={$verify.isPending || $regenerate.isPending} class="flex items-center gap-1.5 rounded-md border border-indigo-500/20 bg-indigo-500/10 px-3 py-1.5 text-xs text-indigo-300 transition-colors hover:bg-indigo-500/20 disabled:opacity-50"><BadgeCheck class={`h-3.5 w-3.5 ${$verify.isPending ? 'animate-pulse' : ''}`} /> {$verify.isPending ? 'Verifying…' : 'Verify Evidence'}</button>
							</div>
						</div>

						{#if $verify.isError}
							<div transition:fade={{ duration: 150 }} class="flex items-start justify-between gap-3 rounded-xl border border-rose-500/20 bg-rose-500/5 p-4">
								<div class="flex items-start gap-3">
									<AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
									<div>
										<p class="text-sm font-medium text-rose-300">Verification failed</p>
										<p class="mt-1 text-xs text-rose-200/70">{$verify.error instanceof Error ? $verify.error.message : 'Unknown error'}</p>
									</div>
								</div>
								<button onclick={() => $verify.reset()} class="text-zinc-500 hover:text-zinc-300" aria-label="Dismiss"><X class="h-4 w-4" /></button>
							</div>
						{:else if verifyResult}
							{@const clean = verifyResult.unsupportedCount === 0}
							<div transition:fade={{ duration: 150 }} class={cn('rounded-xl border p-4', clean ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-rose-500/20 bg-rose-500/5')}>
								<div class="flex items-start justify-between gap-3">
									<div class="flex items-start gap-3">
										{#if clean}<BadgeCheck class="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />{:else}<MessageSquareWarning class="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />{/if}
										<div>
											<p class={cn('text-sm font-semibold', clean ? 'text-emerald-300' : 'text-rose-300')}>
												Evidence verification: {pct(verifyResult.faithfulness)} faithful
											</p>
											<p class="mt-1 text-xs text-zinc-400">
												{verifyResult.supportedSentences} of {verifyResult.totalSentences} sentences grounded against {verifyResult.evidenceClaims} evidence claims ·
												{verifyResult.nliUsed ? 'strict NLI entailment + citation anchoring' : 'citation anchoring only — no NLI provider configured'}
												· {fmtTime(verifyResult.verifiedAt)}
											</p>
										</div>
									</div>
									<button onclick={() => $verify.reset()} class="text-zinc-500 hover:text-zinc-300" aria-label="Dismiss verification result"><X class="h-4 w-4" /></button>
								</div>
								{#if failedSections.length}
									<div class="mt-4 space-y-3 border-t border-zinc-800/60 pt-3">
										{#each failedSections as fs (fs.sectionId)}
											<div>
												<p class="text-xs font-medium text-zinc-300">{fs.title} <span class="text-zinc-500">— {fs.unsupported.length} of {fs.total} unsupported</span></p>
												<ul class="mt-1.5 space-y-1.5">
													{#each fs.unsupported as u (u.claimId)}
														<li class="flex items-start gap-2 text-xs">
															<AlertTriangle class="mt-0.5 h-3 w-3 shrink-0 text-rose-400" />
															<span class="text-zinc-400">“{u.content}” <span class="ml-1 rounded border border-rose-500/20 bg-rose-500/10 px-1.5 py-0.5 text-[10px] text-rose-300">{REASON_LABELS[u.reason]}</span></span>
														</li>
													{/each}
												</ul>
											</div>
										{/each}
									</div>
								{/if}
							</div>
						{/if}

						{#if topic.sections && topic.sections.length}
							<div class="space-y-6">
								{#each topic.sections as section (section.id)}
									{@const Icon = iconByName(section.icon)}
									{@const claims = section.claims}
									<div class="glass-panel overflow-hidden rounded-xl border-zinc-800">
										<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-4 py-3">
											<div class="flex items-center gap-3">
												<div class="rounded bg-zinc-800/80 p-1.5 text-zinc-400"><Icon class="h-4 w-4" /></div>
												<h3 class="font-medium text-zinc-200">{section.title}</h3>
											</div>
											<button onclick={() => openModal(section.id)} class="flex items-center gap-1 text-xs text-zinc-400 transition-colors hover:text-indigo-300"><Plus class="h-3.5 w-3.5" /> Add Claim</button>
										</div>
										<div class="space-y-3 p-4">
											{#each claims as claim (claim.id)}
												{@const flagged = unsupportedKeys.has(`${section.id}:${claim.id}`)}
												<div class="group flex items-start gap-3">
													<span class={cn('mt-1.5 block h-1.5 w-1.5 shrink-0 rounded-full', flagged ? 'bg-rose-500' : 'bg-indigo-500')}></span>
													<p class="flex-1 text-sm leading-relaxed text-zinc-300">
														{claim.content}
														{#if flagged}<span class="ml-2 inline-flex items-center gap-1 rounded border border-rose-500/20 bg-rose-500/10 px-1.5 py-0.5 align-middle text-[10px] text-rose-300"><AlertTriangle class="h-3 w-3" /> unsupported</span>{/if}
													</p>
													<div class="flex max-w-[150px] flex-wrap justify-end gap-1 opacity-60 transition-opacity group-hover:opacity-100">
														{#each claim.citations as cite (cite)}
															<span class="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-zinc-400 transition-colors hover:border-indigo-500/50 hover:text-indigo-300">{cite}</span>
														{/each}
													</div>
												</div>
											{/each}
											{#if claims.length === 0}<p class="text-sm text-zinc-500 italic">No claims added to this section yet.</p>{/if}
										</div>
									</div>
								{/each}
							</div>
						{:else}
							<div class="rounded-xl border border-dashed border-zinc-800 py-16 text-center text-sm text-zinc-500">This topic's SSOT is still being assembled.</div>
						{/if}
					</div>
				{:else if activeTab === 'coverage'}
					<div in:fade={{ duration: 150 }} class="space-y-6">
						<header><h2 class="text-lg font-semibold text-zinc-200">Source Coverage Matrix</h2><p class="mt-1 text-sm text-zinc-500">Which registered sources contribute to specific aspects of this topic, from live claim citations.</p></header>
						{#if $sourcesQuery.isLoading}
							<Skeleton class="h-48 rounded-xl" />
						{:else if registeredSources.length === 0}
							<div class="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-800 py-16 text-center">
								<Database class="h-8 w-8 text-zinc-600" />
								<p class="text-sm text-zinc-400">No sources registered yet.</p>
								<a href="/admin/sources" class="text-xs text-indigo-300 underline-offset-2 hover:underline">Register sources to unlock the coverage matrix →</a>
							</div>
						{:else if coverageMatrix.length === 0}
							<div class="rounded-xl border border-dashed border-zinc-800 py-16 text-center text-sm text-zinc-500">This topic's SSOT is still being assembled — coverage appears once sections exist.</div>
						{:else}
							<div class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
								<div class="overflow-x-auto">
									<table class="w-full text-left text-sm">
										<thead class="border-b border-zinc-800 bg-zinc-900/50 font-mono text-xs text-zinc-400">
											<tr>
												<th class="px-4 py-3 font-medium">Topic Aspect</th>
												{#each registeredSources as s (s.id)}<th class="border-l border-zinc-800/50 px-4 py-3 font-medium" title={s.name}>{s.id}</th>{/each}
												<th class="border-l border-zinc-800 bg-zinc-900 px-4 py-3 font-medium">SSOT Status</th>
											</tr>
										</thead>
										<tbody class="divide-y divide-zinc-800/50 text-zinc-300">
											{#each coverageMatrix as row (row.aspect)}
												<tr class="transition-colors hover:bg-zinc-900/30">
													<td class="px-4 py-3 font-medium text-zinc-200">{row.aspect}</td>
													{#each row.cells as cell, ci (registeredSources[ci].id)}
														<td class="border-l border-zinc-800/50 px-4 py-3 text-xs {cellClass(cell)}">{cell === 'None' ? '--' : cell}</td>
													{/each}
													<td class="border-l border-zinc-800 bg-zinc-900/30 px-4 py-3">
														<span class={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs', row.status === 'Covered' ? 'text-emerald-400' : row.status === 'Improved' ? 'text-indigo-400' : 'border border-rose-500/20 bg-rose-500/10 text-rose-400')}>
															{#if row.status === 'Covered'}<CheckCircle2 class="h-3.5 w-3.5" />{:else if row.status === 'Improved'}<GitMerge class="h-3.5 w-3.5" />{:else}<MessageSquareWarning class="h-3.5 w-3.5" />{/if}
															{row.status}
														</span>
													</td>
												</tr>
											{/each}
										</tbody>
									</table>
								</div>
							</div>
						{/if}
					</div>
				{:else if activeTab === 'claims'}
					<div in:fade={{ duration: 150 }} class="space-y-6">
						<header>
							<h2 class="text-lg font-semibold text-zinc-200">Claims Inspector</h2>
							<p class="mt-1 text-sm text-zinc-500">The normalized claims layer behind this SSOT: type, confidence, ontology grounding, source provenance, and the supersede chain.</p>
						</header>
						{#if $claimsQuery.isLoading}
							<div class="space-y-3">{#each Array(4) as _, i (i)}<Skeleton class="h-24 rounded-xl" />{/each}</div>
						{:else if $claimsQuery.isError}
							<div class="rounded-xl border border-rose-500/20 bg-rose-500/5 p-4 text-sm text-rose-300">Failed to load claims: {$claimsQuery.error instanceof Error ? $claimsQuery.error.message : 'Unknown error'}</div>
						{:else if allClaims.length === 0}
							<div class="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-800 py-16 text-center">
								<ListChecks class="h-8 w-8 text-zinc-600" />
								<p class="text-sm text-zinc-400">No normalized claims recorded for this topic yet.</p>
								<p class="text-xs text-zinc-600">Claims are extracted during document ingestion and by the SSOT backfill job.</p>
							</div>
						{:else}
							<div class="flex flex-wrap items-center gap-2">
								{#each CLAIM_STATUSES as status (status)}
									{@const count = claimStatusCount(status)}
									{#if status === 'all' || count > 0}
										<button
											onclick={() => (claimStatusFilter = status)}
											class={cn(
												'rounded-full border px-3 py-1 text-xs capitalize transition-colors',
												claimStatusFilter === status ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300' : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
											)}
										>
											{status} <span class="ml-1 font-mono text-[10px] text-zinc-500">{count}</span>
										</button>
									{/if}
								{/each}
							</div>
							<div class="space-y-3">
								{#each filteredClaims as claim (claim.id)}
									<div class="glass-panel rounded-xl border border-zinc-800 p-4">
										<div class="flex flex-wrap items-center gap-2">
											<span class="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">{claim.claimType}</span>
											<span class={cn('rounded-full border px-2 py-0.5 text-[10px] capitalize', claimStatusClass(claim.status))}>{claim.status}</span>
											<span class="flex items-center gap-1.5 text-[10px] text-zinc-500">
												confidence
												<span class="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-zinc-800"><span class="block h-full rounded-full bg-indigo-500" style="width: {Math.round(claim.confidence * 100)}%"></span></span>
												<span class="font-mono text-zinc-400">{Math.round(claim.confidence * 100)}%</span>
											</span>
											<span class="ml-auto font-mono text-[10px] text-zinc-600" title="Claim id">{claim.id}</span>
										</div>
										<p class={cn('mt-2.5 text-sm leading-relaxed', claim.status === 'superseded' || claim.status === 'retired' ? 'text-zinc-500 line-through decoration-zinc-700' : 'text-zinc-300')}>{claim.claimText}</p>
										{#if claim.ontologyIds.length || claim.systemTags.length || claim.examTags.length}
											<div class="mt-2.5 flex flex-wrap gap-1.5">
												{#each claim.ontologyIds as oid (oid)}
													<span class="rounded border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 font-mono text-[10px] text-indigo-300" title="Ontology concept">{oid}</span>
												{/each}
												{#each claim.systemTags as tag (tag)}
													<span class="rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-400" title="Body system">{tag}</span>
												{/each}
												{#each claim.examTags as tag (tag)}
													<span class="rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300" title="Exam tag">{tag}</span>
												{/each}
											</div>
										{/if}
										{#if claim.supersededByClaimId || claim.supersedesClaimId}
											<div class="mt-2.5 flex flex-wrap gap-3 text-[11px]">
												{#if claim.supersededByClaimId}
													<span class="flex items-center gap-1 text-rose-400"><GitMerge class="h-3 w-3" /> Superseded by <span class="font-mono">{claim.supersededByClaimId}</span></span>
												{/if}
												{#if claim.supersedesClaimId}
													<span class="flex items-center gap-1 text-zinc-400"><GitMerge class="h-3 w-3" /> Supersedes <span class="font-mono">{claim.supersedesClaimId}</span></span>
												{/if}
											</div>
										{/if}
										<div class="mt-3 flex flex-wrap items-center gap-1.5 border-t border-zinc-800/60 pt-2.5">
											<span class="text-[10px] tracking-wider text-zinc-600 uppercase">Provenance</span>
											{#if claim.sources.length}
												{#each claim.sources as src (src.id)}
													<span class={cn('rounded border px-1.5 py-0.5 font-mono text-[10px]', src.sourceId ? 'border-indigo-500/30 bg-indigo-500/5 text-indigo-300' : 'border-zinc-700 bg-zinc-800 text-zinc-400')} title={src.sourceId ? 'Linked to the source registry' : 'Raw citation token / document reference'}>
														{provenanceToken(src)}{#if src.stance !== 'supports'}<span class="ml-1 text-rose-400">({src.stance})</span>{/if}
													</span>
												{/each}
											{:else}
												<span class="text-[10px] text-zinc-600 italic">none recorded</span>
											{/if}
										</div>
									</div>
								{/each}
								{#if filteredClaims.length === 0}
									<div class="rounded-xl border border-dashed border-zinc-800 py-10 text-center text-sm text-zinc-500">No {claimStatusFilter} claims.</div>
								{/if}
							</div>
						{/if}
					</div>
				{:else if activeTab === 'delta'}
					<div in:fade={{ duration: 150 }} class="space-y-6">
						<header><h2 class="text-lg font-semibold text-zinc-200">Delta Knowledge Extract</h2><p class="mt-1 text-sm text-zinc-500">Changes detected for this topic during recent source ingestion.</p></header>
						{#if delta.length === 0}
							<div class="rounded-xl border border-dashed border-zinc-800 py-16 text-center text-sm text-zinc-500">No delta events recorded for this topic yet.</div>
						{:else}
							<div class="space-y-4">
								{#each delta as d (d.id)}
									<div class="glass-panel flex items-start gap-4 rounded-xl border border-zinc-800 p-4">
										<div class={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', changeTypeClass(d.type))}>
											{#if d.type === 'conflict'}<MessageSquareWarning class="h-4 w-4" />{:else}<GitMerge class="h-4 w-4" />{/if}
										</div>
										<div>
											<h4 class="font-medium text-zinc-200">{d.text}</h4>
											<p class="mt-1 text-sm text-zinc-500">{d.details}</p>
											{#if d.type === 'conflict'}<a href="/review" class="mt-3 inline-block rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300 transition-colors hover:bg-rose-500/20">Review Conflicts in Queue →</a>{/if}
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{:else}
					<div in:fade={{ duration: 150 }} class="space-y-6">
						<header>
							<h2 class="text-lg font-semibold text-zinc-200">Version History</h2>
							<p class="mt-1 text-sm text-zinc-500">A version is recorded on every SSOT merge, regeneration, and restore. Restoring writes the snapshot back as a new version — history is append-only.</p>
						</header>
						{#if $restore.isError}
							<div class="flex items-start gap-3 rounded-xl border border-rose-500/20 bg-rose-500/5 p-4 text-sm text-rose-300">
								<AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" /> Restore failed: {$restore.error instanceof Error ? $restore.error.message : 'Unknown error'}
							</div>
						{:else if $restore.isSuccess && $restore.data}
							<div class="flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm text-emerald-300">
								<CheckCircle2 class="mt-0.5 h-4 w-4 shrink-0" />
								Restored from v{$restore.data.restoredFrom}{#if $restore.data.version}&nbsp;— recorded as v{$restore.data.version}{/if}.
							</div>
						{/if}
						{#if $versionsQuery.isLoading}
							<div class="space-y-3">{#each Array(3) as _, i (i)}<Skeleton class="h-24 rounded-xl" />{/each}</div>
						{:else if $versionsQuery.isError}
							<div class="rounded-xl border border-rose-500/20 bg-rose-500/5 p-4 text-sm text-rose-300">Failed to load versions: {$versionsQuery.error instanceof Error ? $versionsQuery.error.message : 'Unknown error'}</div>
						{:else}
							{@const versions = $versionsQuery.data ?? []}
							{#if versions.length === 0}
								<div class="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-800 py-16 text-center">
									<History class="h-8 w-8 text-zinc-600" />
									<p class="text-sm text-zinc-400">No versions recorded yet.</p>
									<p class="text-xs text-zinc-600">Regenerate the topic or ingest a source to create the first snapshot.</p>
								</div>
							{:else}
								<div class="space-y-3">
									{#each versions as v, i (v.id)}
										<div class="glass-panel rounded-xl border border-zinc-800 p-4">
											<div class="flex flex-wrap items-center gap-2">
												<span class="rounded-md border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 font-mono text-xs font-semibold text-indigo-300">v{v.version}</span>
												{#if i === 0}<span class="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400">Current</span>{/if}
												{#if v.faithfulness != null}
													<span class={cn('rounded-full border px-2 py-0.5 text-[10px]', v.faithfulness >= 0.9 ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400' : v.faithfulness >= 0.7 ? 'border-amber-500/20 bg-amber-500/10 text-amber-400' : 'border-rose-500/20 bg-rose-500/10 text-rose-400')}>faithfulness {pct(v.faithfulness)}</span>
												{/if}
												<span class="ml-auto flex items-center gap-2 text-xs text-zinc-500">
													{#if v.createdBy}<span class="text-zinc-400">{v.createdBy}</span> ·{/if}
													{fmtTime(v.createdAt)}
												</span>
											</div>
											{#if v.changelog.length}
												<ul class="mt-3 space-y-1.5">
													{#each v.changelog as entry, ei (ei)}
														<li class="flex items-start gap-2 text-xs">
															<span class={cn('mt-px rounded px-1.5 py-0.5 text-[10px] capitalize', changeTypeClass(entry.type))}>{entry.type}</span>
															<span class="text-zinc-400">{entry.text}{#if entry.details}<span class="text-zinc-600"> — {entry.details}</span>{/if}</span>
														</li>
													{/each}
												</ul>
											{:else}
												<p class="mt-3 text-xs text-zinc-600 italic">No changelog recorded for this version.</p>
											{/if}
											{#if i !== 0}
												<div class="mt-3 flex items-center gap-2 border-t border-zinc-800/60 pt-3">
													{#if confirmRestore === v.version}
														<span class="text-xs text-amber-300">Overwrite the live SSOT with this snapshot?</span>
														<button
															onclick={() => { $restore.mutate(v.version); confirmRestore = null; }}
															disabled={$restore.isPending}
															class="rounded-md bg-amber-600/90 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-500 disabled:opacity-50"
														>Confirm restore</button>
														<button onclick={() => (confirmRestore = null)} class="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
													{:else}
														<button
															onclick={() => (confirmRestore = v.version)}
															disabled={$restore.isPending}
															class="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"
														>
															<RotateCcw class={`h-3 w-3 ${$restore.isPending && $restore.variables === v.version ? 'animate-spin' : ''}`} />
															{$restore.isPending && $restore.variables === v.version ? 'Restoring…' : 'Restore this version'}
														</button>
													{/if}
												</div>
											{/if}
										</div>
									{/each}
								</div>
							{/if}
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</div>

	{#if modalSection}
		<div transition:fade={{ duration: 150 }} class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
			<div transition:scale={{ duration: 150, start: 0.95 }} class="flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl">
				<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 p-4">
					<h2 class="text-lg font-semibold text-zinc-100">Add Claim & Reference</h2>
					<button onclick={() => (modalSection = null)} class="text-zinc-500 hover:text-zinc-300"><X class="h-5 w-5" /></button>
				</div>
				<div class="space-y-5 p-5">
					<div>
						<label for="claim" class="mb-1.5 block text-sm font-medium text-zinc-300">Claim Content</label>
						<textarea id="claim" bind:value={claimText} placeholder="Enter the factual claim to add to the SSOT..." class="h-24 w-full resize-none rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:ring-1 focus:ring-indigo-500/50 focus:outline-none"></textarea>
					</div>
					<div class="border-t border-zinc-900 pt-2">
						<label for="cite" class="mb-1.5 block text-sm font-medium text-zinc-300">Citations & Source References</label>
						<p class="mb-3 text-xs text-zinc-500">
							Add supporting citations as registered source ids{#if registeredSources.length}&nbsp;(e.g. '{registeredSources[0].id}', 'p45'){:else}&nbsp;and locators{/if}.
						</p>
						<div class="mb-3 flex gap-2">
							<input id="cite" bind:value={citeInput} onkeydown={(e) => e.key === 'Enter' && addCitation()} placeholder={registeredSources.length ? `e.g. ${registeredSources[0].id}, p104` : 'e.g. source id, p104'} class="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:ring-1 focus:ring-indigo-500/50 focus:outline-none" />
							<button onclick={addCitation} disabled={!citeInput.trim()} class="rounded-md bg-zinc-800 px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-50">Add</button>
						</div>
						<div class="flex min-h-[40px] flex-wrap items-start gap-2">
							{#if citations.length === 0}<span class="mt-1 text-xs text-zinc-600 italic">No citations added yet.</span>{:else}
								{#each citations as cite, idx (idx)}
									<div class="inline-flex items-center rounded border border-indigo-500/30 bg-indigo-500/10 px-2 py-1 text-xs text-indigo-300">
										<span class="mr-2 font-mono">{cite}</span>
										<button onclick={() => (citations = citations.filter((_, i) => i !== idx))} class="text-indigo-400 hover:text-rose-400"><Trash2 class="h-3 w-3" /></button>
									</div>
								{/each}
							{/if}
						</div>
					</div>
				</div>
				<div class="flex justify-end gap-3 border-t border-zinc-800 bg-zinc-900/30 p-4 py-3">
					<button onclick={() => (modalSection = null)} class="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200">Cancel</button>
					<button onclick={saveClaim} disabled={!claimText.trim() || citations.length === 0} class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">Save to SSOT</button>
				</div>
			</div>
		</div>
	{/if}
{:else}
	<div class="py-16 text-center text-zinc-500">Topic not found.</div>
{/if}
