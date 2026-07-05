<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { fade, fly, scale } from 'svelte/transition';
	import {
		Clock,
		Plus,
		Save,
		Loader2,
		CheckCircle2,
		ChevronLeft,
		Trash2,
		AlertCircle
	} from '@lucide/svelte';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { Button, Skeleton } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import type { ResearchProject, TimelineEventItem } from '@insightlibrary/api-client';

	const queryClient = useQueryClient();
	const projectId = $derived(page.url.searchParams.get('id'));

	const project = $derived(
		createQuery({
			queryKey: ['research', 'project', projectId],
			queryFn: () => api.getResearchProject<'timeline'>(projectId as string),
			enabled: !!projectId
		})
	);

	let events = $state<TimelineEventItem[]>([]);
	let title = $state('');
	let loadedId = $state<string | null>(null);

	$effect(() => {
		const p = $project.data;
		if (p && p.id !== loadedId) {
			events = structuredClone(p.data.events ?? []);
			title = p.title;
			loadedId = p.id;
			dirty = false;
		}
	});

	let dirty = $state(false);
	function markDirty() {
		dirty = true;
	}

	function addEvent() {
		events = [
			...events,
			{
				id: `e${Date.now()}`,
				phase: `Phase ${events.length + 1}`,
				stage: 'New',
				description: '',
				tone: 'default'
			}
		];
		markDirty();
	}
	function removeEvent(id: string) {
		events = events.filter((e) => e.id !== id);
		markDirty();
	}
	function toggleTone(ev: TimelineEventItem) {
		ev.tone = ev.tone === 'critical' ? 'default' : 'critical';
		markDirty();
	}

	// ── Save ───────────────────────────────────────────────────────────────────
	const save = createMutation({
		mutationFn: () => api.updateResearchProject<'timeline'>(projectId!, { title, data: { events } }),
		onSuccess: (updated: ResearchProject<'timeline'>) => {
			dirty = false;
			queryClient.setQueryData(['research', 'project', projectId], updated);
			queryClient.invalidateQueries({ queryKey: ['research', 'projects'] });
		}
	});

	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		void events;
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

<div class="mx-auto flex min-h-[calc(100vh-6rem)] max-w-2xl flex-col">
	<a
		href="/research"
		class="mx-auto mt-2 flex w-max items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
	>
		<ChevronLeft class="h-3.5 w-3.5" /> Back to Research Workspace
	</a>

	{#if !projectId}
		<div class="flex flex-1 flex-col items-center justify-center gap-4 text-center">
			<div class="flex h-16 w-16 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900">
				<Clock class="h-8 w-8 text-indigo-400" />
			</div>
			<div>
				<h1 class="text-2xl font-bold tracking-tight text-zinc-100">Timeline Builder</h1>
				<p class="mx-auto mt-2 max-w-md text-sm text-zinc-400">
					Open or create a timeline project from the Research Workspace to start sequencing events.
				</p>
			</div>
			<Button href="/research"><Plus class="h-4 w-4" /> Go to Research Workspace</Button>
		</div>
	{:else if $project.isLoading}
		<div class="mt-8 w-full space-y-4">
			<Skeleton class="mx-auto h-8 w-64" />
			<Skeleton class="h-64 w-full" />
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
				<Clock class="h-8 w-8 text-indigo-400" />
			</div>

			<div>
				<input
					bind:value={title}
					oninput={markDirty}
					class="mx-auto block w-full max-w-lg rounded-md border border-transparent bg-transparent text-center text-3xl font-bold tracking-tight text-zinc-100 transition-colors hover:border-zinc-800 focus:border-indigo-500/50 focus:bg-zinc-950 focus:outline-none"
					aria-label="Project title"
				/>
				<p class="mx-auto mt-2 max-w-lg text-sm text-zinc-400">
					Sequence events, disease-progression stages, or publication milestones chronologically.
				</p>
			</div>

			<!-- Timeline canvas -->
			<div class="glass-panel relative mt-8 rounded-xl border border-dashed border-zinc-800 p-6">
				{#if events.length === 0}
					<p class="py-8 text-sm text-zinc-500">No events yet. Add the first stage below.</p>
				{:else}
					<div class="absolute top-10 bottom-10 left-8 w-px bg-indigo-500/30"></div>
					<div class="space-y-6">
						{#each events as event (event.id)}
							<div in:scale={{ duration: 200, start: 0.96 }} class="group relative flex items-start gap-4 pl-2 text-left">
								<button
									onclick={() => toggleTone(event)}
									class={cn(
										'z-10 mt-4 h-4 w-4 shrink-0 rounded-full border-4 border-zinc-950 transition-colors',
										event.tone === 'critical'
											? 'bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.5)]'
											: 'bg-indigo-500'
									)}
									title="Toggle critical"
									aria-label="Toggle critical for {event.phase}"
								></button>
								<div
									class={cn(
										'flex-1 rounded border p-3 transition-colors',
										event.tone === 'critical'
											? 'border-rose-900/50 bg-rose-950/20'
											: 'border-zinc-800 bg-zinc-900/80'
									)}
								>
									<div class="mb-2 flex items-center gap-2">
										<input
											bind:value={event.phase}
											oninput={markDirty}
											class={cn(
												'w-24 rounded border border-transparent bg-transparent font-mono text-[10px] tracking-wider uppercase hover:border-zinc-700 focus:border-indigo-500/50 focus:outline-none',
												event.tone === 'critical' ? 'text-rose-500' : 'text-zinc-500'
											)}
											aria-label="Phase"
										/>
										<span class="text-zinc-700">·</span>
										<input
											bind:value={event.stage}
											oninput={markDirty}
											placeholder="Stage"
											class="w-28 rounded border border-transparent bg-transparent font-mono text-xs text-zinc-400 placeholder:text-zinc-600 hover:border-zinc-700 focus:border-indigo-500/50 focus:outline-none"
											aria-label="Stage"
										/>
										<button
											onclick={() => removeEvent(event.id)}
											class="ml-auto rounded p-0.5 text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100 hover:text-rose-400"
											aria-label="Remove event"
										>
											<Trash2 class="h-3.5 w-3.5" />
										</button>
									</div>
									<textarea
										bind:value={event.description}
										oninput={markDirty}
										rows="2"
										placeholder="Describe this stage of progression…"
										class="w-full resize-none rounded border border-transparent bg-transparent text-sm text-zinc-300 placeholder:text-zinc-600 hover:border-zinc-700 focus:border-indigo-500/50 focus:bg-zinc-950/50 focus:outline-none"
									></textarea>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Actions -->
			<div class="flex justify-center gap-3 pt-2">
				<Button variant="outline" onclick={addEvent}>
					<Plus class="h-4 w-4" /> Add Event
				</Button>
				<Button onclick={saveNow} disabled={$save.isPending}>
					{#if $save.isPending}
						<Loader2 class="h-4 w-4 animate-spin" /> Saving…
					{:else if !dirty}
						<CheckCircle2 class="h-4 w-4" /> Saved
					{:else}
						<Save class="h-4 w-4" /> Save Timeline
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
