<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { fade, fly } from 'svelte/transition';
	import {
		Activity,
		ChevronLeft,
		Plus,
		Save,
		Loader2,
		CheckCircle2,
		Trash2,
		AlertCircle,
		X
	} from '@lucide/svelte';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { Button, Skeleton } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import type { MatrixCell, MatrixCellTone, MatrixRow, ResearchProject } from '@insightlibrary/api-client';

	const queryClient = useQueryClient();
	const projectId = $derived(page.url.searchParams.get('id'));

	const project = $derived(
		createQuery({
			queryKey: ['research', 'project', projectId],
			queryFn: () => api.getResearchProject<'compare_matrix'>(projectId as string),
			enabled: !!projectId
		})
	);

	let columns = $state<string[]>([]);
	let rows = $state<MatrixRow[]>([]);
	let title = $state('');
	let loadedId = $state<string | null>(null);

	$effect(() => {
		const p = $project.data;
		if (p && p.id !== loadedId) {
			columns = structuredClone(p.data.columns ?? []);
			rows = structuredClone(p.data.rows ?? []);
			title = p.title;
			loadedId = p.id;
			dirty = false;
		}
	});

	const toneCycle: MatrixCellTone[] = ['default', 'agree', 'conflict', 'missing'];
	const cellTones: Record<MatrixCellTone, string> = {
		default: 'text-zinc-300',
		agree: 'text-indigo-300 bg-indigo-500/10',
		conflict: 'text-rose-300 bg-rose-500/10',
		missing: 'text-zinc-500 italic'
	};
	const toneLabels: Record<MatrixCellTone, string> = {
		default: 'Neutral',
		agree: 'Agreement',
		conflict: 'Conflict',
		missing: 'Not covered'
	};

	let dirty = $state(false);
	function markDirty() {
		dirty = true;
	}

	function ensureCellWidth(row: MatrixRow) {
		while (row.cells.length < columns.length) row.cells.push({ text: '' });
		if (row.cells.length > columns.length) row.cells.length = columns.length;
	}

	// Must match compareMatrixSchema.columns/.cells .max(12) on the server; adding
	// past it would make every autosave 400 and silently drop the extra columns.
	const MAX_COLUMNS = 12;
	const atColumnCap = $derived(columns.length >= MAX_COLUMNS);
	function addColumn() {
		if (columns.length >= MAX_COLUMNS) return;
		columns = [...columns, `Source ${columns.length + 1}`];
		for (const r of rows) r.cells.push({ text: '' });
		markDirty();
	}
	function removeColumn(idx: number) {
		columns = columns.filter((_, i) => i !== idx);
		for (const r of rows) r.cells = r.cells.filter((_, i) => i !== idx);
		markDirty();
	}
	function addRow() {
		const cells: MatrixCell[] = columns.map(() => ({ text: '' }));
		rows = [...rows, { id: `r${Date.now()}`, concept: '', cells }];
		markDirty();
	}
	function removeRow(id: string) {
		rows = rows.filter((r) => r.id !== id);
		markDirty();
	}
	function cycleTone(row: MatrixRow, idx: number) {
		const cell = row.cells[idx];
		const cur = cell.tone ?? 'default';
		const next = toneCycle[(toneCycle.indexOf(cur) + 1) % toneCycle.length];
		cell.tone = next === 'default' ? undefined : next;
		markDirty();
	}

	// ── Save ───────────────────────────────────────────────────────────────────
	const save = createMutation({
		mutationFn: () => {
			for (const r of rows) ensureCellWidth(r);
			return api.updateResearchProject<'compare_matrix'>(projectId!, { title, data: { columns, rows } });
		},
		onSuccess: (updated: ResearchProject<'compare_matrix'>) => {
			dirty = false;
			queryClient.setQueryData(['research', 'project', projectId], updated);
			queryClient.invalidateQueries({ queryKey: ['research', 'projects'] });
		},
		onError: () => {
			// Stop the pending autosave timer so a rejected write doesn't retry-loop
			// on every keystroke; the next explicit Save (or edit) will try again.
			clearTimeout(saveTimer);
		}
	});

	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		void columns;
		void rows;
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

<div class="mx-auto max-w-6xl space-y-6">
	<a
		href="/research"
		class="flex w-max items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
	>
		<ChevronLeft class="h-3.5 w-3.5" /> Back to Research Workspace
	</a>

	{#if !projectId}
		<div class="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
			<div class="flex h-16 w-16 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900">
				<Activity class="h-8 w-8 text-indigo-400" />
			</div>
			<div>
				<h1 class="text-2xl font-bold tracking-tight text-zinc-100">Source Comparison Matrix</h1>
				<p class="mx-auto mt-2 max-w-md text-sm text-zinc-400">
					Open or create a compare-matrix project from the Research Workspace. New matrices seed their
					columns from your registered sources.
				</p>
			</div>
			<Button href="/research"><Plus class="h-4 w-4" /> Go to Research Workspace</Button>
		</div>
	{:else if $project.isLoading}
		<div class="space-y-4">
			<Skeleton class="h-8 w-64" />
			<Skeleton class="h-64 w-full" />
		</div>
	{:else if $project.isError}
		<div class="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
			<AlertCircle class="h-8 w-8 text-rose-400" />
			<p class="text-sm text-rose-300">This project could not be loaded. It may have been deleted.</p>
			<Button variant="outline" href="/research">Back to Research Workspace</Button>
		</div>
	{:else if $project.data}
		<div in:fade={{ duration: 200 }} class="space-y-6">
			<header class="flex flex-col justify-between gap-4 md:flex-row md:items-end">
				<div class="min-w-0">
					<h1 class="flex items-center gap-2 text-2xl font-bold tracking-tight text-zinc-100">
						<Activity class="h-6 w-6 shrink-0 text-indigo-400" />
						<input
							bind:value={title}
							oninput={markDirty}
							class="w-full min-w-0 rounded-md border border-transparent bg-transparent text-2xl font-bold tracking-tight text-zinc-100 transition-colors hover:border-zinc-800 focus:border-indigo-500/50 focus:bg-zinc-950 focus:outline-none"
							aria-label="Project title"
						/>
					</h1>
					<p class="mt-1 text-sm text-zinc-400">
						Side-by-side analysis of how sources define corresponding concepts. Click a cell tag to
						flag agreement or conflict.
					</p>
				</div>
				<Button onclick={saveNow} disabled={$save.isPending} class="shrink-0">
					{#if $save.isPending}
						<Loader2 class="h-4 w-4 animate-spin" /> Saving…
					{:else if !dirty}
						<CheckCircle2 class="h-4 w-4" /> Saved
					{:else}
						<Save class="h-4 w-4" /> Save Matrix
					{/if}
				</Button>
			</header>

			{#if columns.length === 0 && rows.length === 0}
				<div class="glass-panel rounded-xl border border-dashed border-zinc-800 p-10 text-center">
					<p class="text-sm text-zinc-500">
						This matrix is empty. Add source columns and concept rows to begin comparing.
					</p>
					<div class="mt-4 flex justify-center gap-3">
						<Button variant="outline" onclick={addColumn} disabled={atColumnCap}
						><Plus class="h-4 w-4" /> Add Column</Button
					>
						<Button variant="outline" onclick={addRow}><Plus class="h-4 w-4" /> Add Row</Button>
					</div>
				</div>
			{:else}
				<div class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
					<div class="overflow-x-auto">
						<table class="w-full text-left text-sm">
							<thead class="border-b border-zinc-800 bg-zinc-900/50 font-mono text-xs text-zinc-400">
								<tr>
									<th class="w-56 min-w-56 px-4 py-3 font-medium">Concept / Metric</th>
									{#each columns as col, i (i)}
										<th class="min-w-48 border-l border-zinc-800/50 px-4 py-3 font-medium">
											<div class="flex items-center gap-2">
												<input
													bind:value={columns[i]}
													oninput={markDirty}
													class="w-full rounded border border-transparent bg-transparent text-xs text-zinc-300 hover:border-zinc-700 focus:border-indigo-500/50 focus:outline-none"
													aria-label="Column {i + 1} header"
												/>
												<button
													onclick={() => removeColumn(i)}
													class="shrink-0 rounded p-0.5 text-zinc-600 transition-colors hover:text-rose-400"
													aria-label="Remove column {col}"
												>
													<X class="h-3.5 w-3.5" />
												</button>
											</div>
										</th>
									{/each}
									<th class="w-12 border-l border-zinc-800/50 px-2 py-3 text-center">
										<button
											onclick={addColumn}
											disabled={atColumnCap}
											title={atColumnCap ? 'Maximum of 12 sources' : 'Add column'}
											class="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-indigo-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-500"
											aria-label="Add column"
										>
											<Plus class="h-4 w-4" />
										</button>
									</th>
								</tr>
							</thead>
							<tbody class="divide-y divide-zinc-800/50 text-zinc-300">
								{#each rows as row (row.id)}
									<tr class="group transition-colors hover:bg-zinc-900/30">
										<td class="px-4 py-3 align-top">
											<div class="flex items-start gap-2">
												<textarea
													bind:value={row.concept}
													oninput={markDirty}
													rows="1"
													placeholder="Concept…"
													class="w-full resize-none rounded border border-transparent bg-transparent font-medium text-zinc-200 placeholder:text-zinc-600 hover:border-zinc-700 focus:border-indigo-500/50 focus:outline-none"
												></textarea>
												<button
													onclick={() => removeRow(row.id)}
													class="mt-0.5 shrink-0 rounded p-0.5 text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100 hover:text-rose-400"
													aria-label="Remove row"
												>
													<Trash2 class="h-3.5 w-3.5" />
												</button>
											</div>
										</td>
										{#each columns as _, ci (ci)}
											{@const cell = row.cells[ci] ?? { text: '' }}
											<td class={cn('border-l border-zinc-800/50 px-4 py-3 align-top', cellTones[cell.tone ?? 'default'])}>
												<textarea
													value={cell.text}
													oninput={(e) => {
														if (!row.cells[ci]) row.cells[ci] = { text: '' };
														row.cells[ci].text = e.currentTarget.value;
														markDirty();
													}}
													rows="2"
													placeholder="—"
													class="w-full resize-none rounded border border-transparent bg-transparent placeholder:text-zinc-600 hover:border-zinc-700 focus:border-indigo-500/50 focus:outline-none"
												></textarea>
												<button
													onclick={() => cycleTone(row, ci)}
													class="mt-1 rounded px-1.5 py-0.5 text-[9px] tracking-wider uppercase transition-colors hover:bg-zinc-800"
													title="Cycle status"
												>
													{toneLabels[cell.tone ?? 'default']}
												</button>
											</td>
										{/each}
										<td class="border-l border-zinc-800/50"></td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<div class="border-t border-zinc-800 bg-zinc-900/30 px-4 py-2">
						<button
							onclick={addRow}
							class="flex items-center gap-2 text-xs font-medium text-zinc-500 transition-colors hover:text-indigo-400"
						>
							<Plus class="h-3.5 w-3.5" /> Add concept row
						</button>
					</div>
				</div>
			{/if}

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
