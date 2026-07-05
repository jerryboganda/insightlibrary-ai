<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { Database, Plus, Pencil, Check, X, AlertTriangle, BookMarked } from '@lucide/svelte';
	import { fade } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import type { Source } from '@insightlibrary/schemas';

	const queryClient = useQueryClient();

	// The org source registry (A5): ids double as citation tokens — claim
	// provenance (claim_sources.source_id), the SSOT coverage matrix columns,
	// and conflict-resolution priority all resolve against these rows.
	const sourcesQuery = createQuery({ queryKey: ['sources'], queryFn: () => api.listSources() });
	const sources = $derived($sourcesQuery.data ?? []);

	function errText(e: unknown): string {
		return e instanceof Error ? e.message : 'Request failed';
	}

	// ── Register a new source ─────────────────────────────────────────────────
	let showCreate = $state(false);
	let draftName = $state('');
	let draftAuthor = $state('');
	let draftType = $state('Textbook');
	let draftPriority = $state(3);
	let draftDate = $state(String(new Date().getFullYear()));

	const createSource = createMutation({
		mutationFn: () =>
			api.createSource({
				name: draftName.trim(),
				author: draftAuthor.trim(),
				type: draftType.trim() || 'Textbook',
				priority: draftPriority,
				date: draftDate.trim() || undefined
			}),
		onSuccess: () => {
			showCreate = false;
			draftName = '';
			draftAuthor = '';
			draftType = 'Textbook';
			draftPriority = 3;
			draftDate = String(new Date().getFullYear());
			queryClient.invalidateQueries({ queryKey: ['sources'] });
		}
	});

	// ── Inline edit ───────────────────────────────────────────────────────────
	let editingId = $state<string | null>(null);
	let editName = $state('');
	let editAuthor = $state('');
	let editType = $state('');
	let editPriority = $state(3);
	let editDate = $state('');

	function startEdit(s: Source) {
		editingId = s.id;
		editName = s.name;
		editAuthor = s.author;
		editType = s.type;
		editPriority = s.priority;
		editDate = s.date;
		$updateSource.reset();
	}
	function cancelEdit() {
		editingId = null;
	}

	const updateSource = createMutation({
		mutationFn: (id: string) =>
			api.updateSource(id, {
				name: editName.trim(),
				author: editAuthor.trim(),
				type: editType.trim() || 'Textbook',
				priority: editPriority,
				date: editDate.trim() || undefined
			}),
		onSuccess: () => {
			editingId = null;
			queryClient.invalidateQueries({ queryKey: ['sources'] });
		}
	});

	function priorityTone(p: number): string {
		if (p <= 1) return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400';
		if (p <= 3) return 'border-indigo-500/20 bg-indigo-500/10 text-indigo-300';
		return 'border-zinc-700 bg-zinc-800 text-zinc-400';
	}
</script>

<main class="relative w-full overflow-y-auto">
	<div class="mx-auto max-w-6xl space-y-8">
		<header class="flex flex-col justify-between gap-4 md:flex-row md:items-center">
			<div>
				<h1 class="flex items-center gap-2 text-2xl font-bold tracking-tight text-zinc-100">
					<Database class="h-6 w-6 text-indigo-400" />
					Source Registry
				</h1>
				<p class="mt-1 text-sm text-zinc-400">
					Registered sources drive conflict-resolution priority, the topic coverage matrix columns,
					and claim provenance. A source's <span class="font-mono text-xs">id</span> is its citation token.
				</p>
			</div>
			<button
				onclick={() => {
					showCreate = !showCreate;
					$createSource.reset();
				}}
				class="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
			>
				<Plus class="h-4 w-4" /> Register Source
			</button>
		</header>

		{#if showCreate}
			<div transition:fade={{ duration: 150 }} class="glass-panel rounded-xl border border-indigo-500/20 p-5">
				<h2 class="flex items-center gap-2 text-sm font-semibold text-zinc-200">
					<BookMarked class="h-4 w-4 text-indigo-400" /> New source
				</h2>
				<div class="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
					<div>
						<label for="src-name" class="mb-1.5 block text-xs font-medium text-zinc-400">Name</label>
						<input id="src-name" bind:value={draftName} placeholder="e.g. Harrison's Principles of Internal Medicine" class="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none" />
						<p class="mt-1 text-[11px] text-zinc-600">Documents whose title matches this name are linked to it during claim extraction.</p>
					</div>
					<div>
						<label for="src-author" class="mb-1.5 block text-xs font-medium text-zinc-400">Author / Publisher</label>
						<input id="src-author" bind:value={draftAuthor} placeholder="e.g. McGraw Hill" class="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none" />
					</div>
					<div>
						<label for="src-type" class="mb-1.5 block text-xs font-medium text-zinc-400">Type</label>
						<input id="src-type" bind:value={draftType} placeholder="Textbook" list="source-types" class="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none" />
					</div>
					<div class="grid grid-cols-2 gap-4">
						<div>
							<label for="src-priority" class="mb-1.5 block text-xs font-medium text-zinc-400">Priority <span class="text-zinc-600">(1 = highest)</span></label>
							<input id="src-priority" type="number" min="1" max="10" bind:value={draftPriority} class="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none" />
						</div>
						<div>
							<label for="src-date" class="mb-1.5 block text-xs font-medium text-zinc-400">Edition / Year</label>
							<input id="src-date" bind:value={draftDate} placeholder="2026" class="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none" />
						</div>
					</div>
				</div>
				{#if $createSource.isError}
					<p class="mt-3 flex items-center gap-1.5 text-xs text-rose-400">
						<AlertTriangle class="h-3.5 w-3.5" /> {errText($createSource.error)}
					</p>
				{/if}
				<div class="mt-4 flex justify-end gap-3 border-t border-zinc-800/60 pt-4">
					<button onclick={() => (showCreate = false)} class="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200">Cancel</button>
					<button
						onclick={() => $createSource.mutate()}
						disabled={!draftName.trim() || $createSource.isPending}
						class="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{$createSource.isPending ? 'Registering…' : 'Register'}
					</button>
				</div>
			</div>
		{/if}

		<div class="glass-panel overflow-hidden rounded-xl border-zinc-800">
			<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
				<h2 class="text-sm font-semibold text-zinc-200">Registered sources</h2>
				{#if !$sourcesQuery.isLoading}
					<span class="font-mono text-xs text-zinc-500">{sources.length} sources</span>
				{/if}
			</div>

			{#if $sourcesQuery.isLoading}
				<div class="space-y-3 p-6">
					{#each Array(4) as _, i (i)}
						<Skeleton class="h-11 rounded-md" />
					{/each}
				</div>
			{:else if sources.length === 0}
				<div class="flex flex-col items-center gap-2 px-6 py-16 text-center">
					<Database class="h-8 w-8 text-zinc-600" />
					<p class="text-sm text-zinc-400">No sources registered yet.</p>
					<p class="text-xs text-zinc-600">
						Register the books and references your library ingests so claims, coverage, and conflict resolution can attribute to them.
					</p>
				</div>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full text-left text-sm">
						<thead class="border-b border-zinc-800/50 bg-zinc-950/80 text-xs font-medium tracking-wider text-zinc-500 uppercase">
							<tr>
								<th class="px-6 py-4">ID</th>
								<th class="px-6 py-4">Name</th>
								<th class="px-6 py-4">Author</th>
								<th class="px-6 py-4">Type</th>
								<th class="px-6 py-4">Priority</th>
								<th class="px-6 py-4">Edition</th>
								<th class="px-6 py-4 text-right">Actions</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-zinc-800/50 text-zinc-300">
							{#each sources as s (s.id)}
								{#if editingId === s.id}
									<tr class="bg-zinc-900/40">
										<td class="px-6 py-3 font-mono text-xs text-zinc-500">{s.id}</td>
										<td class="px-6 py-3"><input bind:value={editName} aria-label="Name" class="w-full min-w-40 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 focus:border-indigo-500/50 focus:outline-none" /></td>
										<td class="px-6 py-3"><input bind:value={editAuthor} aria-label="Author" class="w-full min-w-28 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 focus:border-indigo-500/50 focus:outline-none" /></td>
										<td class="px-6 py-3"><input bind:value={editType} aria-label="Type" list="source-types" class="w-full min-w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 focus:border-indigo-500/50 focus:outline-none" /></td>
										<td class="px-6 py-3"><input type="number" min="1" max="10" bind:value={editPriority} aria-label="Priority" class="w-16 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 focus:border-indigo-500/50 focus:outline-none" /></td>
										<td class="px-6 py-3"><input bind:value={editDate} aria-label="Edition" class="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 focus:border-indigo-500/50 focus:outline-none" /></td>
										<td class="px-6 py-3">
											<div class="flex items-center justify-end gap-2">
												<button
													onclick={() => $updateSource.mutate(s.id)}
													disabled={!editName.trim() || $updateSource.isPending}
													class="flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
												>
													<Check class="h-3 w-3" /> {$updateSource.isPending ? 'Saving…' : 'Save'}
												</button>
												<button onclick={cancelEdit} class="rounded-md p-1 text-zinc-500 transition-colors hover:text-zinc-200" aria-label="Cancel edit"><X class="h-4 w-4" /></button>
											</div>
											{#if $updateSource.isError}
												<p class="mt-1.5 text-right text-[11px] text-rose-400">{errText($updateSource.error)}</p>
											{/if}
										</td>
									</tr>
								{:else}
									<tr class="transition-colors hover:bg-zinc-900/40">
										<td class="px-6 py-4 font-mono text-xs text-indigo-300/80" title="Citation token">{s.id}</td>
										<td class="px-6 py-4 font-medium text-zinc-200">{s.name}</td>
										<td class="px-6 py-4 text-zinc-400">{s.author || '—'}</td>
										<td class="px-6 py-4 text-zinc-400">{s.type}</td>
										<td class="px-6 py-4">
											<span class="rounded-full border px-2 py-0.5 font-mono text-[11px] {priorityTone(s.priority)}" title="1 = highest priority in conflict resolution">P{s.priority}</span>
										</td>
										<td class="px-6 py-4 font-mono text-xs text-zinc-500">{s.date}</td>
										<td class="px-6 py-4 text-right">
											<button onclick={() => startEdit(s)} class="text-zinc-500 transition-colors hover:text-indigo-300" aria-label="Edit {s.name}">
												<Pencil class="h-4 w-4" />
											</button>
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>

		<div class="flex gap-3 rounded-md border border-indigo-500/20 bg-indigo-500/5 p-3 text-xs leading-relaxed text-indigo-200/70">
			<Database class="mt-0.5 h-4 w-4 shrink-0 text-indigo-400" />
			Source ids are referenced by claim provenance and citations, so they cannot be changed after
			registration. During ingestion, documents are matched to sources by name to stamp
			<span class="font-mono">claim_sources.source_id</span>; unmatched documents keep their raw
			document-id provenance.
		</div>
	</div>

	<!-- Shared type suggestions for both the create form and inline row editing. -->
	<datalist id="source-types">
		<option value="Textbook"></option>
		<option value="Review Guide"></option>
		<option value="Journal Article"></option>
		<option value="Clinical Guideline"></option>
		<option value="Lecture Notes"></option>
	</datalist>
</main>
