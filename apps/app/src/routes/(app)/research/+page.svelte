<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { fade, fly } from 'svelte/transition';
	import {
		Plus,
		Network,
		Clock,
		Table2,
		FileStack,
		ChevronRight,
		Loader2,
		Trash2,
		X
	} from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { api } from '$lib/api';
	import { PageHeader, Button, Skeleton } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import type { ResearchProject, ResearchType } from '@insightlibrary/api-client';

	const queryClient = useQueryClient();

	// Real, persisted projects (replaces the prototype's hardcoded board/evidence).
	const projects = createQuery({
		queryKey: ['research', 'projects'],
		queryFn: () => api.listResearchProjects()
	});

	type ToolMeta = {
		type: ResearchType;
		route: string;
		title: string;
		description: string;
		icon: typeof Network;
		accent: string;
		iconBg: string;
		dot: string;
	};
	const tools: ToolMeta[] = [
		{
			type: 'argument_map',
			route: '/research/argument-map',
			title: 'Argument Map',
			description:
				'Construct logical arguments from source claims. Draw connections between premises, evidence, and conclusions.',
			icon: Network,
			accent: 'hover:border-indigo-500/50',
			iconBg: 'bg-indigo-500/10 text-indigo-400 group-hover:bg-indigo-500/20',
			dot: 'bg-indigo-400'
		},
		{
			type: 'compare_matrix',
			route: '/research/compare-matrix',
			title: 'Compare Matrix',
			description:
				'Line up sources side by side to surface agreements, contradictions, and gaps across the literature.',
			icon: Table2,
			accent: 'hover:border-emerald-500/50',
			iconBg: 'bg-emerald-500/10 text-emerald-400 group-hover:bg-emerald-500/20',
			dot: 'bg-emerald-400'
		},
		{
			type: 'report',
			route: '/research/report-builder',
			title: 'Report Builder',
			description:
				'Assemble a cited synthesis report from your SSOT evidence, then export to Markdown.',
			icon: FileStack,
			accent: 'hover:border-amber-500/50',
			iconBg: 'bg-amber-500/10 text-amber-400 group-hover:bg-amber-500/20',
			dot: 'bg-amber-400'
		},
		{
			type: 'timeline',
			route: '/research/timeline-builder',
			title: 'Timeline Builder',
			description:
				'Sequence events, findings, and revisions chronologically to trace how understanding evolved.',
			icon: Clock,
			accent: 'hover:border-blue-500/50',
			iconBg: 'bg-blue-500/10 text-blue-400 group-hover:bg-blue-500/20',
			dot: 'bg-blue-400'
		}
	];
	const routeFor: Record<ResearchType, string> = {
		argument_map: '/research/argument-map',
		compare_matrix: '/research/compare-matrix',
		report: '/research/report-builder',
		timeline: '/research/timeline-builder'
	};
	const labelFor: Record<ResearchType, string> = {
		argument_map: 'Argument Map',
		compare_matrix: 'Compare Matrix',
		report: 'Report',
		timeline: 'Timeline'
	};

	const projectsByType = $derived.by(() => {
		const map: Record<ResearchType, ResearchProject[]> = {
			argument_map: [],
			compare_matrix: [],
			report: [],
			timeline: []
		};
		for (const p of $projects.data ?? []) map[p.type]?.push(p);
		return map;
	});

	// ── Create ─────────────────────────────────────────────────────────────────
	let createOpen = $state(false);
	let createType = $state<ResearchType>('argument_map');
	let createTitle = $state('');

	const createProject = createMutation({
		mutationFn: (input: { type: ResearchType; title: string }) =>
			api.createResearchProject(input.type, input.title),
		onSuccess: async (project) => {
			await queryClient.invalidateQueries({ queryKey: ['research', 'projects'] });
			createOpen = false;
			createTitle = '';
			goto(`${routeFor[project.type]}?id=${project.id}`);
		}
	});

	function openCreate(type: ResearchType) {
		createType = type;
		createTitle = '';
		createOpen = true;
	}
	function submitCreate() {
		const title = createTitle.trim();
		if (!title || $createProject.isPending) return;
		$createProject.mutate({ type: createType, title });
	}

	// ── Delete ───────────────────────────────────────────────────────────────
	const deleteProject = createMutation({
		mutationFn: (id: string) => api.deleteResearchProject(id),
		onSettled: () => queryClient.invalidateQueries({ queryKey: ['research', 'projects'] })
	});

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	}

	const totalProjects = $derived(($projects.data ?? []).length);
</script>

<div class="mx-auto max-w-6xl space-y-8">
	<PageHeader
		title="Research Workspace"
		description="Build argument maps, comparison matrices, cited reports, and timelines — each saved as a project."
	>
		{#snippet actions()}
			<Button onclick={() => openCreate('argument_map')}>
				<Plus class="h-4 w-4" /> New Project
			</Button>
		{/snippet}
	</PageHeader>

	{#if $createProject.isError}
		<p class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
			Could not create the project. Research projects require the database — this feature is
			unavailable in the in-memory dev mode.
		</p>
	{/if}

	<!-- Tools grid: each card creates a new project of its type -->
	<section class="space-y-4">
		<h2 class="text-sm font-semibold tracking-wide text-zinc-300 uppercase">Research Tools</h2>
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
			{#each tools as tool, i (tool.type)}
				<button
					type="button"
					onclick={() => openCreate(tool.type)}
					in:fly={{ y: 8, duration: 200, delay: i * 40 }}
					class={cn(
						'group flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950/50 p-5 text-left backdrop-blur-sm transition-colors hover:bg-zinc-900/40',
						tool.accent
					)}
				>
					<div class="flex items-start justify-between">
						<div
							class={cn(
								'flex h-11 w-11 items-center justify-center rounded-lg transition-colors',
								tool.iconBg
							)}
						>
							<tool.icon class="h-5 w-5" />
						</div>
						<span class="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
							{projectsByType[tool.type].length}
							<ChevronRight
								class="h-4 w-4 text-zinc-600 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-400"
							/>
						</span>
					</div>
					<div>
						<h3 class="text-base font-semibold text-zinc-100">{tool.title}</h3>
						<p class="mt-1 text-sm leading-relaxed text-zinc-400">{tool.description}</p>
					</div>
				</button>
			{/each}
		</div>
	</section>

	<!-- Projects: the real persisted list -->
	<section class="space-y-4">
		<div class="flex items-center justify-between">
			<h2 class="text-sm font-semibold tracking-wide text-zinc-300 uppercase">Your Projects</h2>
			{#if totalProjects > 0}
				<span class="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">{totalProjects}</span>
			{/if}
		</div>

		{#if $projects.isLoading}
			<div class="space-y-2">
				{#each Array(3) as _, i (i)}
					<Skeleton class="h-16 w-full" />
				{/each}
			</div>
		{:else if $projects.isError}
			<div class="rounded-xl border border-zinc-800 bg-zinc-950/50 px-4 py-12 text-center text-sm text-rose-400">
				Failed to load research projects. Please try again.
			</div>
		{:else if totalProjects === 0}
			<div class="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/30 px-4 py-16 text-center">
				<div class="mx-auto flex max-w-sm flex-col items-center gap-3 text-zinc-500">
					<div class="rounded-full bg-zinc-900 p-3">
						<FileStack class="h-6 w-6 text-zinc-600" />
					</div>
					<p class="text-sm">
						No research projects yet. Pick a tool above to create your first one — it saves
						automatically as you work.
					</p>
				</div>
			</div>
		{:else}
			<div class="space-y-2">
				{#each $projects.data ?? [] as project (project.id)}
					<div
						in:fade={{ duration: 150 }}
						class="group flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/50 px-4 py-3 transition-colors hover:border-indigo-500/30 hover:bg-zinc-900/40"
					>
						<a
							href="{routeFor[project.type]}?id={project.id}"
							class="flex min-w-0 flex-1 items-center gap-3"
						>
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-semibold text-zinc-100 group-hover:text-indigo-300">
									{project.title}
								</p>
								<p class="mt-0.5 text-xs text-zinc-500">
									{labelFor[project.type]} · updated {formatDate(project.updatedAt)}
								</p>
							</div>
							<span
								class="rounded-full border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 text-[10px] font-medium text-zinc-400"
							>
								{labelFor[project.type]}
							</span>
						</a>
						<button
							onclick={() => $deleteProject.mutate(project.id)}
							disabled={$deleteProject.isPending && $deleteProject.variables === project.id}
							class="rounded p-1.5 text-zinc-600 transition-colors hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-50"
							aria-label="Delete {project.title}"
						>
							{#if $deleteProject.isPending && $deleteProject.variables === project.id}
								<Loader2 class="h-4 w-4 animate-spin" />
							{:else}
								<Trash2 class="h-4 w-4" />
							{/if}
						</button>
					</div>
				{/each}
			</div>
		{/if}
	</section>
</div>

<!-- Create modal -->
{#if createOpen}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
		transition:fade={{ duration: 150 }}
	>
		<button class="absolute inset-0 cursor-default" aria-label="Close" onclick={() => (createOpen = false)}
		></button>
		<div
			class="relative w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl"
			in:fly={{ y: 8, duration: 150 }}
		>
			<div class="mb-4 flex items-center justify-between">
				<h3 class="text-base font-semibold text-zinc-100">New Research Project</h3>
				<button
					onclick={() => (createOpen = false)}
					class="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
					aria-label="Close"
				>
					<X class="h-4 w-4" />
				</button>
			</div>
			<div class="space-y-4">
				<div>
					<label
						for="new-project-type"
						class="mb-1.5 block text-xs font-medium tracking-wider text-zinc-500 uppercase">Tool</label
					>
					<select
						id="new-project-type"
						bind:value={createType}
						class="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none"
					>
						<option value="argument_map">Argument Map</option>
						<option value="compare_matrix">Compare Matrix</option>
						<option value="report">Report Builder</option>
						<option value="timeline">Timeline Builder</option>
					</select>
				</div>
				<div>
					<label
						for="new-project-title"
						class="mb-1.5 block text-xs font-medium tracking-wider text-zinc-500 uppercase">Title</label
					>
					<input
						id="new-project-title"
						bind:value={createTitle}
						onkeydown={(e) => e.key === 'Enter' && submitCreate()}
						placeholder="e.g. Adrenal Insufficiency Synthesis"
						class="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none"
					/>
				</div>
				{#if $createProject.isError}
					<p class="text-xs text-rose-400">
						Could not create the project. This feature requires the database.
					</p>
				{/if}
				<div class="flex justify-end gap-3 pt-2">
					<Button variant="outline" onclick={() => (createOpen = false)}>Cancel</Button>
					<Button onclick={submitCreate} disabled={!createTitle.trim() || $createProject.isPending}>
						{#if $createProject.isPending}
							<Loader2 class="h-4 w-4 animate-spin" /> Creating…
						{:else}
							<Plus class="h-4 w-4" /> Create
						{/if}
					</Button>
				</div>
			</div>
		</div>
	</div>
{/if}
