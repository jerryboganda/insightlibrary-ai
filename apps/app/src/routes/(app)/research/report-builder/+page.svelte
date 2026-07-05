<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { fade, fly } from 'svelte/transition';
	import {
		LayoutTemplate,
		Save,
		Download,
		PlayCircle,
		Plus,
		MessageSquare,
		CheckSquare,
		Loader2,
		CheckCircle2,
		ChevronLeft,
		AlertCircle,
		X,
		Trash2
	} from '@lucide/svelte';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { Button, Badge, Skeleton } from '$lib/components/ui';
	import type { ReportSource, ResearchProject } from '@insightlibrary/api-client';

	const queryClient = useQueryClient();
	const projectId = $derived(page.url.searchParams.get('id'));

	const project = $derived(
		createQuery({
			queryKey: ['research', 'project', projectId],
			queryFn: () => api.getResearchProject<'report'>(projectId as string),
			enabled: !!projectId
		})
	);

	// SSOT topics — the real, groundable evidence sources for synthesis.
	const topics = createQuery({ queryKey: ['topics'], queryFn: () => api.listTopics() });

	let title = $state('');
	let prompt = $state('');
	let strictCitation = $state(true);
	let sources = $state<ReportSource[]>([]);
	let body = $state('');
	let generatedBy = $state<'ai' | 'manual' | 'fallback' | undefined>(undefined);
	let wordCount = $state(0);
	let citationCount = $state(0);
	let loadedId = $state<string | null>(null);

	$effect(() => {
		const p = $project.data;
		if (p && p.id !== loadedId) {
			title = p.title;
			prompt = p.data.prompt ?? '';
			strictCitation = p.data.strictCitation ?? true;
			sources = structuredClone(p.data.sources ?? []);
			body = p.data.body ?? '';
			generatedBy = p.data.generatedBy;
			wordCount = p.data.wordCount ?? 0;
			citationCount = p.data.citationCount ?? 0;
			loadedId = p.id;
			dirty = false;
		}
	});

	let dirty = $state(false);
	function markDirty() {
		dirty = true;
	}

	// ── Source picker ──────────────────────────────────────────────────────────
	let pickerOpen = $state(false);
	const availableTopics = $derived(
		($topics.data ?? []).filter((t) => !sources.some((s) => s.topicId === t.id))
	);
	function addTopicSource(topicId: string, name: string) {
		sources = [...sources, { id: `s${Date.now()}`, label: `SSOT: ${name}`, topicId }];
		pickerOpen = false;
		markDirty();
	}
	function removeSource(id: string) {
		sources = sources.filter((s) => s.id !== id);
		markDirty();
	}

	function currentData() {
		return { prompt, strictCitation, sources, body, generatedBy, wordCount, citationCount };
	}

	// ── Save ───────────────────────────────────────────────────────────────────
	const save = createMutation({
		mutationFn: () => api.updateResearchProject<'report'>(projectId!, { title, data: currentData() }),
		onSuccess: (updated: ResearchProject<'report'>) => {
			dirty = false;
			queryClient.setQueryData(['research', 'project', projectId], updated);
			queryClient.invalidateQueries({ queryKey: ['research', 'projects'] });
		}
	});

	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		void title;
		void prompt;
		void strictCitation;
		void sources;
		void body;
		if (!dirty || !projectId) return;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => $save.mutate(), 1500);
		return () => clearTimeout(saveTimer);
	});

	function saveNow() {
		if (!projectId || $save.isPending) return;
		clearTimeout(saveTimer);
		$save.mutate();
	}

	// ── Generate (real synthesis through the provider router) ──────────────────
	let genReason = $state('');
	const generate = createMutation({
		// Persist current inputs first so the server generates from the latest state.
		mutationFn: async () => {
			await api.updateResearchProject<'report'>(projectId!, { title, data: currentData() });
			return api.generateResearchReport(projectId!);
		},
		onSuccess: (res) => {
			genReason = '';
			if (res.ok) {
				body = res.body ?? '';
				generatedBy = res.generatedBy;
				wordCount = res.wordCount ?? 0;
				citationCount = res.citationCount ?? 0;
				dirty = false;
				if (res.project) queryClient.setQueryData(['research', 'project', projectId], res.project);
			} else {
				genReason = res.reason ?? 'Nothing to generate yet.';
			}
		}
	});

	function generateDraft() {
		if (!projectId || $generate.isPending) return;
		genReason = '';
		$generate.mutate();
	}

	// ── Export (real Markdown download) ────────────────────────────────────────
	function exportMarkdown() {
		if (!body.trim()) return;
		const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${(title || 'report').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.md`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	function onBodyInput(value: string) {
		body = value;
		generatedBy = 'manual';
		wordCount = (body.trim().match(/\S+/g) ?? []).length;
		markDirty();
	}

	const genLabel = $derived(
		generatedBy === 'ai'
			? 'AI-generated'
			: generatedBy === 'fallback'
				? 'Deterministic digest (no AI provider)'
				: generatedBy === 'manual'
					? 'Edited manually'
					: ''
	);
</script>

<div class="mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-7xl flex-col space-y-6">
	<a
		href="/research"
		class="flex w-max items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
	>
		<ChevronLeft class="h-3.5 w-3.5" /> Back to Research Workspace
	</a>

	{#if !projectId}
		<div class="flex flex-1 flex-col items-center justify-center gap-4 text-center">
			<div class="flex h-16 w-16 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900">
				<LayoutTemplate class="h-8 w-8 text-indigo-400" />
			</div>
			<div>
				<h1 class="text-2xl font-bold tracking-tight text-zinc-100">Research Report Builder</h1>
				<p class="mx-auto mt-2 max-w-md text-sm text-zinc-400">
					Open or create a report project from the Research Workspace to synthesize a cited report.
				</p>
			</div>
			<Button href="/research"><Plus class="h-4 w-4" /> Go to Research Workspace</Button>
		</div>
	{:else if $project.isLoading}
		<div class="space-y-4">
			<Skeleton class="h-8 w-64" />
			<Skeleton class="h-96 w-full" />
		</div>
	{:else if $project.isError}
		<div class="flex flex-1 flex-col items-center justify-center gap-3 text-center">
			<AlertCircle class="h-8 w-8 text-rose-400" />
			<p class="text-sm text-rose-300">This project could not be loaded. It may have been deleted.</p>
			<Button variant="outline" href="/research">Back to Research Workspace</Button>
		</div>
	{:else if $project.data}
		<div in:fade={{ duration: 200 }} class="flex min-h-0 flex-1 flex-col space-y-6">
			<header class="flex shrink-0 flex-col justify-between gap-4 md:flex-row md:items-end">
				<div class="min-w-0">
					<div class="mb-2"><Badge tone="indigo">Copilot Orchestrated</Badge></div>
					<h1 class="flex items-center gap-2 text-2xl font-bold tracking-tight text-zinc-100">
						<LayoutTemplate class="h-6 w-6 shrink-0 text-indigo-400" />
						<input
							bind:value={title}
							oninput={markDirty}
							class="w-full min-w-0 rounded-md border border-transparent bg-transparent text-2xl font-bold tracking-tight text-zinc-100 transition-colors hover:border-zinc-800 focus:border-indigo-500/50 focus:bg-zinc-950 focus:outline-none"
							aria-label="Project title"
						/>
					</h1>
					<p class="mt-1 text-sm text-zinc-400">
						Synthesize your SSOT topic claims into a formal, cited report.
					</p>
				</div>
				<div class="flex shrink-0 gap-3">
					<Button variant="outline" onclick={saveNow} disabled={$save.isPending}>
						{#if $save.isPending}
							<Loader2 class="h-4 w-4 animate-spin" /> Saving…
						{:else if !dirty}
							<CheckCircle2 class="h-4 w-4" /> Saved
						{:else}
							<Save class="h-4 w-4" /> Save Draft
						{/if}
					</Button>
					<Button onclick={exportMarkdown} disabled={!body.trim()}>
						<Download class="h-4 w-4" /> Export Markdown
					</Button>
				</div>
			</header>

			<div class="flex min-h-[500px] flex-1 flex-col gap-6 lg:flex-row">
				<!-- Left: instructions + sources -->
				<div class="flex flex-col gap-6 lg:w-1/3">
					<div class="glass-panel flex flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800">
						<div class="border-b border-zinc-800 bg-zinc-900/50 px-4 py-3">
							<h3 class="text-sm font-medium text-zinc-200">Report Instructions</h3>
						</div>
						<div class="flex flex-1 flex-col space-y-4 p-4">
							<div>
								<label for="prompt-goal" class="mb-2 block text-xs font-medium tracking-wider text-zinc-400 uppercase">
									Prompt Goal
								</label>
								<textarea
									id="prompt-goal"
									bind:value={prompt}
									oninput={markDirty}
									placeholder="e.g. Compare the management guidance across the linked SSOT topics, highlighting contradictions."
									class="h-28 w-full resize-none rounded-md border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none"
								></textarea>
							</div>

							<label class="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
								<input
									type="checkbox"
									bind:checked={strictCitation}
									onchange={markDirty}
									class="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-indigo-500 focus:ring-indigo-500/50"
								/>
								Strict citation mode (drop uncited sentences)
							</label>

							<div>
								<span class="mb-2 block text-xs font-medium tracking-wider text-zinc-400 uppercase">
									Evidence Sources (SSOT topics)
								</span>
								<div class="space-y-2">
									{#each sources as source (source.id)}
										<div
											in:fly={{ y: -4, duration: 150 }}
											class="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900 p-2"
										>
											<CheckSquare class="h-4 w-4 shrink-0 text-emerald-400" />
											<span class="flex-1 truncate text-sm text-zinc-300">{source.label}</span>
											<button
												onclick={() => removeSource(source.id)}
												class="rounded p-0.5 text-zinc-600 transition-colors hover:text-rose-400"
												aria-label="Remove source"
											>
												<Trash2 class="h-3.5 w-3.5" />
											</button>
										</div>
									{:else}
										<p class="rounded border border-dashed border-zinc-800 px-3 py-3 text-center text-xs text-zinc-500">
											No evidence linked. Add an SSOT topic — its claims ground the synthesis.
										</p>
									{/each}
									<div class="relative">
										<button
											onclick={() => (pickerOpen = !pickerOpen)}
											class="flex w-full items-center justify-center gap-2 rounded border border-dashed border-zinc-700 py-2 text-sm text-zinc-500 transition-colors hover:border-zinc-600 hover:text-zinc-300"
										>
											<Plus class="h-4 w-4" /> Add SSOT Topic
										</button>
										{#if pickerOpen}
											<button class="fixed inset-0 z-40 cursor-default" aria-label="Close" onclick={() => (pickerOpen = false)}></button>
											<div
												transition:fade={{ duration: 100 }}
												class="absolute bottom-full left-0 z-50 mb-2 max-h-64 w-full overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-1 shadow-2xl"
											>
												{#if $topics.isLoading}
													<p class="px-3 py-2 text-xs text-zinc-500">Loading topics…</p>
												{:else if availableTopics.length === 0}
													<p class="px-3 py-2 text-xs text-zinc-500">
														{($topics.data ?? []).length === 0 ? 'No SSOT topics exist yet.' : 'All topics already added.'}
													</p>
												{:else}
													{#each availableTopics as t (t.id)}
														<button
															onclick={() => addTopicSource(t.id, t.name)}
															class="block w-full truncate rounded px-3 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-zinc-100"
														>
															{t.name}
														</button>
													{/each}
												{/if}
											</div>
										{/if}
									</div>
								</div>
							</div>

							<div class="mt-auto space-y-2 pt-4">
								<button
									onclick={generateDraft}
									disabled={$generate.isPending}
									class="flex w-full items-center justify-center gap-2 rounded-md bg-zinc-100 px-4 py-2.5 font-medium text-zinc-900 transition-colors hover:bg-white disabled:pointer-events-none disabled:opacity-70"
								>
									{#if $generate.isPending}
										<Loader2 class="h-5 w-5 animate-spin" /> Generating…
									{:else}
										<PlayCircle class="h-5 w-5" /> Generate with Copilot
									{/if}
								</button>
								{#if genReason}
									<p in:fade={{ duration: 150 }} class="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
										{genReason}
									</p>
								{/if}
								{#if $generate.isError}
									<p class="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
										Generation failed. Please try again.
									</p>
								{/if}
							</div>
						</div>
					</div>
				</div>

				<!-- Right: editor -->
				<div class="glass-panel relative flex min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-800 lg:w-2/3">
					<div class="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900/80 px-4 py-2 font-mono text-xs text-zinc-500">
						<span class={$generate.isPending ? 'text-amber-400' : 'text-emerald-400'}>●</span>
						{$generate.isPending ? 'Generating…' : 'Editor'}
						<span class="mx-1">|</span>
						<span>Words: {wordCount}</span>
						<span class="mx-1">|</span>
						<span>Citations: {citationCount}</span>
						{#if genLabel}
							<span class="mx-1">|</span>
							<span class="text-zinc-400">{genLabel}</span>
						{/if}
					</div>
					<div class="min-h-[400px] flex-1 overflow-y-auto bg-zinc-950/50">
						{#if $generate.isPending}
							<div class="mx-auto max-w-2xl space-y-4 p-8">
								<div class="h-8 w-2/3 animate-pulse rounded bg-zinc-800/60"></div>
								<div class="h-4 w-full animate-pulse rounded bg-zinc-800/40"></div>
								<div class="h-4 w-11/12 animate-pulse rounded bg-zinc-800/40"></div>
								<div class="h-4 w-4/5 animate-pulse rounded bg-zinc-800/40"></div>
							</div>
						{:else if !body.trim()}
							<div class="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-zinc-500">
								<MessageSquare class="h-6 w-6" />
								<p class="max-w-sm text-sm">
									No draft yet. Link at least one SSOT topic, then Generate — or type your report
									directly below.
								</p>
								<textarea
									value={body}
									oninput={(e) => onBodyInput(e.currentTarget.value)}
									placeholder="Start writing in Markdown…"
									class="mt-2 h-40 w-full max-w-2xl resize-none rounded-md border border-zinc-800 bg-zinc-950 p-3 text-left font-mono text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none"
								></textarea>
							</div>
						{:else}
							<textarea
								value={body}
								oninput={(e) => onBodyInput(e.currentTarget.value)}
								class="h-full min-h-[400px] w-full resize-none bg-transparent p-8 font-mono text-sm leading-relaxed text-zinc-200 focus:outline-none"
								aria-label="Report body (Markdown)"
							></textarea>
						{/if}
					</div>
				</div>
			</div>

			<p class="h-4 shrink-0 text-xs" aria-live="polite">
				{#if $save.isError}
					<span class="text-rose-400">Save failed — retrying on next edit.</span>
				{:else if $save.isPending}
					<span class="text-zinc-500">Autosaving…</span>
				{:else if dirty}
					<span class="text-zinc-500">Unsaved changes</span>
				{:else}
					<span class="text-emerald-400">All changes saved.</span>
				{/if}
			</p>
		</div>
	{/if}
</div>
