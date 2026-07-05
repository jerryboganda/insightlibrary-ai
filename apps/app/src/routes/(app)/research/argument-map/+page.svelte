<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { fade, fly, scale } from 'svelte/transition';
	import {
		GitMerge,
		Plus,
		Save,
		CheckCircle2,
		Loader2,
		ChevronLeft,
		Trash2,
		AlertCircle
	} from '@lucide/svelte';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { Button, Skeleton } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import type { ArgumentMapNode, ResearchProject } from '@insightlibrary/api-client';

	const queryClient = useQueryClient();
	const projectId = $derived(page.url.searchParams.get('id'));

	const project = $derived(
		createQuery({
			queryKey: ['research', 'project', projectId],
			queryFn: () => api.getResearchProject<'argument_map'>(projectId as string),
			enabled: !!projectId
		})
	);

	// ── Local editable document, hydrated once from the server ─────────────────
	let nodes = $state<ArgumentMapNode[]>([]);
	let title = $state('');
	let loadedId = $state<string | null>(null);

	$effect(() => {
		const p = $project.data;
		if (p && p.id !== loadedId) {
			nodes = structuredClone(p.data.nodes ?? []);
			title = p.title;
			loadedId = p.id;
			dirty = false;
		}
	});

	const kindStyles: Record<ArgumentMapNode['kind'], { box: string; label: string }> = {
		premise: {
			box: 'bg-zinc-900/50 border-zinc-800 hover:border-indigo-500/50',
			label: 'text-zinc-500'
		},
		evidence: {
			box: 'bg-indigo-950/20 border-indigo-900/50 hover:border-indigo-500/50 shadow-[inset_0_0_20px_rgba(99,102,241,0.05)]',
			label: 'text-indigo-400'
		},
		conclusion: {
			box: 'bg-emerald-950/20 border-emerald-900/50 hover:border-emerald-500/50 shadow-[inset_0_0_20px_rgba(16,185,129,0.05)]',
			label: 'text-emerald-500'
		}
	};

	let dirty = $state(false);
	function markDirty() {
		dirty = true;
	}

	function addNode(kind: ArgumentMapNode['kind']) {
		const n = nodes.filter((x) => x.kind === kind).length + 1;
		const label =
			kind === 'conclusion' ? 'Conclusion' : kind === 'evidence' ? `Evidence ${n}` : `Premise ${n}`;
		const newNode: ArgumentMapNode = {
			id: `n${Date.now()}`,
			kind,
			label,
			text: '',
			source: ''
		};
		// Keep the conclusion (if any) last.
		const conclusionIdx = nodes.findIndex((x) => x.kind === 'conclusion');
		if (kind !== 'conclusion' && conclusionIdx !== -1) {
			nodes = [...nodes.slice(0, conclusionIdx), newNode, ...nodes.slice(conclusionIdx)];
		} else {
			nodes = [...nodes, newNode];
		}
		markDirty();
	}

	function removeNode(id: string) {
		nodes = nodes.filter((n) => n.id !== id);
		markDirty();
	}

	// ── Save (explicit + debounced autosave) ──────────────────────────────────
	const save = createMutation({
		mutationFn: () =>
			api.updateResearchProject<'argument_map'>(projectId!, { title, data: { nodes } }),
		onSuccess: (updated: ResearchProject<'argument_map'>) => {
			dirty = false;
			queryClient.setQueryData(['research', 'project', projectId], updated);
			queryClient.invalidateQueries({ queryKey: ['research', 'projects'] });
		}
	});

	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		// Autosave 1.2s after the last edit (touch the reactive deps).
		void nodes;
		void title;
		if (!dirty || !projectId) return;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => $save.mutate(), 1200);
		return () => clearTimeout(saveTimer);
	});

	function saveNow() {
		if (!projectId || $save.isPending) return;
		clearTimeout(saveTimer);
		$save.mutate();
	}
</script>

<div class="mx-auto flex min-h-[calc(100vh-6rem)] max-w-3xl flex-col">
	<a
		href="/research"
		class="mx-auto mt-2 flex w-max items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
	>
		<ChevronLeft class="h-3.5 w-3.5" /> Back to Research Workspace
	</a>

	{#if !projectId}
		<!-- No project selected — honest empty state, not a fake canvas -->
		<div class="flex flex-1 flex-col items-center justify-center gap-4 text-center">
			<div class="flex h-16 w-16 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900">
				<GitMerge class="h-8 w-8 text-indigo-400" />
			</div>
			<div>
				<h1 class="text-2xl font-bold tracking-tight text-zinc-100">Argument Map Builder</h1>
				<p class="mx-auto mt-2 max-w-md text-sm text-zinc-400">
					Open or create an argument-map project from the Research Workspace to start building.
				</p>
			</div>
			<Button href="/research"><Plus class="h-4 w-4" /> Go to Research Workspace</Button>
		</div>
	{:else if $project.isLoading}
		<div class="mt-8 w-full space-y-4">
			<Skeleton class="mx-auto h-8 w-64" />
			<Skeleton class="h-40 w-full" />
		</div>
	{:else if $project.isError}
		<div class="flex flex-1 flex-col items-center justify-center gap-3 text-center">
			<AlertCircle class="h-8 w-8 text-rose-400" />
			<p class="text-sm text-rose-300">This project could not be loaded. It may have been deleted.</p>
			<Button variant="outline" href="/research">Back to Research Workspace</Button>
		</div>
	{:else if $project.data}
		<div class="w-full space-y-6 text-center" in:fade={{ duration: 200 }}>
			<div
				class="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900"
			>
				<GitMerge class="h-8 w-8 text-indigo-400" />
			</div>

			<div>
				<input
					bind:value={title}
					oninput={markDirty}
					class="mx-auto block w-full max-w-lg rounded-md border border-transparent bg-transparent text-center text-3xl font-bold tracking-tight text-zinc-100 transition-colors hover:border-zinc-800 focus:border-indigo-500/50 focus:bg-zinc-950 focus:outline-none"
					aria-label="Project title"
				/>
				<p class="mx-auto mt-2 max-w-lg text-sm text-zinc-400">
					Build a logical argument from source claims. Add premises and evidence that lead to a
					conclusion; cite a source on each node.
				</p>
			</div>

			<!-- Map canvas -->
			<div class="glass-panel mt-4 rounded-xl border border-dashed border-zinc-800 p-8">
				{#if nodes.length === 0}
					<p class="py-8 text-sm text-zinc-500">
						No nodes yet. Add a premise, evidence, or conclusion below.
					</p>
				{:else}
					<div class="flex flex-col items-center">
						{#each nodes as node, i (node.id)}
							<div
								in:scale={{ duration: 200, start: 0.95 }}
								class={cn(
									'group relative w-full max-w-sm rounded-lg border p-4 text-left transition-colors',
									kindStyles[node.kind].box
								)}
							>
								<div class="mb-1 flex items-center justify-between gap-2">
									<select
										bind:value={node.kind}
										onchange={markDirty}
										class={cn(
											'-ml-1 rounded border border-transparent bg-transparent font-mono text-[10px] tracking-wider uppercase hover:border-zinc-700 focus:border-indigo-500/50 focus:outline-none',
											kindStyles[node.kind].label
										)}
										aria-label="Node kind"
									>
										<option value="premise">Premise</option>
										<option value="evidence">Evidence</option>
										<option value="conclusion">Conclusion</option>
									</select>
									<button
										onclick={() => removeNode(node.id)}
										class="rounded p-0.5 text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100 hover:text-rose-400"
										aria-label="Remove node"
									>
										<Trash2 class="h-3.5 w-3.5" />
									</button>
								</div>
								<textarea
									bind:value={node.text}
									oninput={markDirty}
									rows="2"
									placeholder="State this premise / evidence / conclusion…"
									class="w-full resize-none rounded border border-transparent bg-transparent text-sm text-zinc-300 placeholder:text-zinc-600 hover:border-zinc-700 focus:border-indigo-500/50 focus:bg-zinc-950/50 focus:outline-none"
								></textarea>
								<div class="mt-2 flex items-center gap-1 text-[10px] text-indigo-400">
									<span class="text-zinc-500">Source:</span>
									<input
										bind:value={node.source}
										oninput={markDirty}
										placeholder="e.g. bk-A p22 or a claim id"
										class="flex-1 rounded border border-transparent bg-transparent text-indigo-300 placeholder:text-zinc-600 hover:border-zinc-700 focus:border-indigo-500/50 focus:outline-none"
									/>
								</div>
							</div>

							{#if i < nodes.length - 1}
								<div class="my-1 h-8 w-px bg-zinc-700"></div>
							{/if}
						{/each}
					</div>
				{/if}
			</div>

			<!-- Actions -->
			<div class="flex flex-wrap items-center justify-center gap-3 pt-2">
				<Button variant="outline" onclick={() => addNode('premise')}>
					<Plus class="h-4 w-4" /> Premise
				</Button>
				<Button variant="outline" onclick={() => addNode('evidence')}>
					<Plus class="h-4 w-4" /> Evidence
				</Button>
				<Button variant="outline" onclick={() => addNode('conclusion')}>
					<Plus class="h-4 w-4" /> Conclusion
				</Button>
				<Button onclick={saveNow} disabled={$save.isPending}>
					{#if $save.isPending}
						<Loader2 class="h-4 w-4 animate-spin" /> Saving…
					{:else if !dirty}
						<CheckCircle2 class="h-4 w-4" /> Saved
					{:else}
						<Save class="h-4 w-4" /> Save Map
					{/if}
				</Button>
			</div>

			<p class="h-4 text-xs" aria-live="polite">
				{#if $save.isError}
					<span in:fly={{ y: -4, duration: 150 }} class="text-rose-400">Save failed — retrying on next edit.</span>
				{:else if $save.isPending}
					<span class="text-zinc-500">Autosaving…</span>
				{:else if dirty}
					<span class="text-zinc-500">Unsaved changes</span>
				{:else}
					<span in:fly={{ y: -4, duration: 150 }} class="text-emerald-400">All changes saved.</span>
				{/if}
			</p>
		</div>
	{/if}
</div>
